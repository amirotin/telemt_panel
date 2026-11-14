import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebProfilesField } from "./WebProfilesField";
import { getStrings } from "../../i18n";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function Harness({ initial = [], usernames = ["alice", "bob"], pending = false, error = false, retry }: {
  initial?: Array<Record<string, unknown>>; usernames?: string[]; pending?: boolean; error?: boolean; retry?: () => void;
}) {
  const [profiles, setProfiles] = useState(initial);
  return <><WebProfilesField enabled profiles={profiles} usernames={usernames} usersPending={pending} usersError={error} onRetryUsers={retry} onChange={setProfiles} /><output>{JSON.stringify(profiles)}</output></>;
}
const snapshot = () => JSON.parse(container.querySelector("output")!.textContent!);
const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
function focus() { expect(input()).not.toBeNull(); act(() => input().focus()); }
function type(text: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text); input().dispatchEvent(new Event("input", { bubbles: true })); });
}
function choose(name: string, mode: string) {
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.getAttribute("aria-label") === `${name} · ${mode}`)!;
  expect(option).toBeDefined();
  act(() => option.click());
}
function remove(name: string, mode: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="Удалить профиль ${name} · ${mode}"]`)!;
  expect(button).not.toBeNull();
  act(() => button.click());
}

it("uses one input for immediate filtering and adds profiles directly as removable chips", () => {
  act(() => root.render(<Harness />));
  focus(); type("BO");
  expect([...document.querySelectorAll('[role="option"]')].map((node) => node.getAttribute("aria-label"))).toEqual(["bob · plain", "bob · dd"]);
  choose("bob", "dd");
  expect(snapshot()).toEqual([{ user: "bob", secret_mode: "dd" }]);
  expect(input().value).toBe("");
  expect(container.querySelectorAll('input')).toHaveLength(1);
  expect(container.querySelectorAll("select")).toHaveLength(0);
  expect(container.querySelector('button[aria-label="Удалить профиль bob · dd"]')).not.toBeNull();
  remove("bob", "dd");
  expect(snapshot()).toEqual([]);
});

it("allows both modes for one user without duplicates and preserves other profiles and limits", () => {
  const existing = { user: "alice", secret_mode: "plain", max_sessions: 7, future: "keep" };
  act(() => root.render(<Harness initial={[existing]} />));
  focus();
  choose("alice", "dd");
  choose("bob", "plain");
  expect(snapshot()).toEqual([existing, { user: "alice", secret_mode: "dd" }, { user: "bob", secret_mode: "plain" }]);
  remove("alice", "dd");
  expect(snapshot()).toEqual([existing, { user: "bob", secret_mode: "plain" }]);
  choose("bob", "plain");
  expect(snapshot()).toEqual([existing]);
});

it("supports keyboard selection and Escape without submitting or removing chips on Backspace", () => {
  act(() => root.render(<Harness />));
  focus(); type("bob");
  const key = (value: string) => act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
  key("ArrowDown"); key("Enter");
  expect(snapshot()).toEqual([{ user: "bob", secret_mode: "dd" }]);
  key("Backspace");
  expect(snapshot()).toHaveLength(1);
  key("Escape");
  expect(input().getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it("dismisses the popup on outside interaction and preserves selections", () => {
  act(() => root.render(<Harness initial={[{ user: "alice", secret_mode: "plain" }]} />));
  focus();
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(snapshot()).toEqual([{ user: "alice", secret_mode: "plain" }]);
});

it.each([{ pending: true }, { error: true }, { usernames: [] }])("keeps existing chips removable when user choices are unavailable: %j", (props) => {
  act(() => root.render(<Harness initial={[{ user: "alice", secret_mode: "dd", max_streams: 10 }]} {...props} />));
  focus();
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  remove("alice", "dd");
  expect(snapshot()).toEqual([]);
});

it("reports no matches without changing the current assignment", () => {
  act(() => root.render(<Harness initial={[{ user: "alice", secret_mode: "plain" }]} />));
  focus(); type("missing");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  expect(document.body.textContent).toContain("Подходящие пользователи не найдены");
  expect(snapshot()).toEqual([{ user: "alice", secret_mode: "plain" }]);
});

it("bounds the result list and can still search users beyond the initial page", () => {
  const usernames = Array.from({ length: 5000 }, (_, index) => `user${String(index).padStart(4, "0")}`);
  act(() => root.render(<Harness usernames={usernames} />));
  focus();
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(40);
  expect(document.body.textContent).toContain("Показано пользователей: 20 из 5000");
  type("user4999"); choose("user4999", "dd");
  expect(snapshot()).toEqual([{ user: "user4999", secret_mode: "dd" }]);
});

it("renders only three chips for thousands of assignments and removes a hidden match without losing the draft", () => {
  const profiles = Array.from({ length: 2000 }, (_, index) => ({ user: `user${String(index).padStart(4, "0")}`, secret_mode: "plain", max_sessions: index + 1, future: "keep" }));
  act(() => root.render(<Harness initial={profiles} usernames={profiles.map((profile) => profile.user)} />));
  expect(container.querySelectorAll('button[aria-label^="Удалить профиль "]')).toHaveLength(3);
  expect(container.textContent).toContain("+1997");
  const summary = container.querySelector<HTMLButtonElement>('button[aria-label="Показать выбранные профили: ещё 1997"]');
  expect(summary).not.toBeNull();
  act(() => summary!.click());
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(20);
  type("user1999");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  choose("user1999", "plain");
  const next = snapshot();
  expect(next).toHaveLength(1999);
  expect(next[0]).toEqual({ user: "user0000", secret_mode: "plain", max_sessions: 1, future: "keep" });
  expect(next.at(-1)).toEqual({ user: "user1998", secret_mode: "plain", max_sessions: 1999, future: "keep" });
  expect(container.querySelectorAll('button[aria-label^="Удалить профиль "]')).toHaveLength(3);
  expect(container.textContent).toContain("+1996");
});

it("manages hidden selections even when loading available users failed", () => {
  const profiles = Array.from({ length: 10 }, (_, index) => ({ user: `selected${index}`, secret_mode: "dd" }));
  act(() => root.render(<Harness initial={profiles} usernames={[]} error />));
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Показать выбранные профили: ещё 7"]')!.click());
  type("selected9"); choose("selected9", "dd");
  expect(snapshot()).toHaveLength(9);
  expect(snapshot().some((profile: { user: string }) => profile.user === "selected9")).toBe(false);
});

it("lets the keyboard switch between selected-only and all users without escaping the field", () => {
  const profiles = Array.from({ length: 4 }, (_, index) => ({ user: `selected${index}`, secret_mode: "plain" }));
  act(() => root.render(<Harness initial={profiles} usernames={[...profiles.map((profile) => profile.user), "other"]} />));
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Показать выбранные профили: ещё 1"]')!.click());
  act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  const switchView = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Все пользователи");
  expect(switchView).toBeDefined();
  expect(document.activeElement).toBe(switchView);
  act(() => switchView!.click());
  expect(document.activeElement).toBe(input());
  type("other"); choose("other", "dd");
  expect(snapshot()).toHaveLength(5);
  expect(container.querySelectorAll('button[aria-label^="Удалить профиль "]')).toHaveLength(3);
});

it("returns keyboard focus to the input after removing the focused chip", () => {
  act(() => root.render(<Harness initial={[{ user: "alice", secret_mode: "plain" }]} />));
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Удалить профиль alice · plain"]')!.focus());
  remove("alice", "plain");
  expect(document.activeElement).toBe(input());
});

it("keeps Retry reachable when Tab closes the failed user popup", () => {
  let retries = 0;
  act(() => root.render(<Harness error retry={() => { retries++; }} />));
  focus();
  act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === getStrings().common.retry);
  expect(retry).toBeDefined();
  act(() => retry!.focus());
  act(() => retry!.click());
  expect(retries).toBe(1);
  expect(document.activeElement).toBe(input());
});

it("keeps the popup visible above the input when chips extend beyond a shortened viewport", () => {
  act(() => root.render(<Harness initial={[{ user: "alice", secret_mode: "plain" }, { user: "bob", secret_mode: "dd" }]} />));
  const field = input().parentElement!.parentElement!;
  vi.stubGlobal("innerHeight", 300);
  vi.stubGlobal("innerWidth", 360);
  const rect = (top: number, height: number) => ({ x: 12, y: top, left: 12, top, width: 336, height, right: 348, bottom: top + height, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === field) return rect(-400, 650);
    if (this === input()) return rect(180, 44);
    return rect(0, 100);
  });
  focus();
  const popup = document.querySelector<HTMLElement>('[role="listbox"]')!.parentElement!;
  expect(Number.parseFloat(popup.style.maxHeight)).toBeGreaterThanOrEqual(88);
  expect(Number.parseFloat(popup.style.top)).toBeGreaterThanOrEqual(12);
  expect(Number.parseFloat(popup.style.top) + 100).toBeLessThanOrEqual(300);
});
