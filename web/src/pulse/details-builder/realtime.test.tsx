// Spec §19.1–19.2 against a REAL page fed by a REAL SSE frame.
//
// state.test.tsx already proves the reducer holds nothing a payload can
// reach; that is the argument. This file is the evidence: MePage mounted on
// the router, subscribed through sseClient to a FakeEventSource, put into
// each of the four states a reader is actually in when a frame lands —
// scrolled, with a detail surface open, mid-search, and past a «Показать
// ещё» — and then pushed a new snapshot with changed numbers.
//
// The frame carries a brand-new object graph every time (JSON.parse of a
// fresh string), so nothing here can pass by accident of shared identity.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayModeProvider } from "../../display-mode";
import { SSEProvider } from "../../realtime";
import { createSSEClient, type SSEClient } from "../../realtime/sseClient";
import { FakeEventSource, fakeEventSourceFactory, latestInstance } from "../../realtime/testing/fakeEventSource";
import type { UpstreamsTopic } from "../../realtime/topics";
import { MePage } from "../diag/MePage";
import { upstreamsSnapshot } from "./__fixtures__";
import { validateDetailSearch } from "./state";

const TS = 1_756_000_000;

// pushUpstreams emits an `upstreams` frame. `bump` shifts every writer's
// RTT so the new payload is observably different, not just a new object.
function pushUpstreams(bump: number, ts: number) {
  const writers = upstreamsSnapshot.me_writers!;
  const next: UpstreamsTopic = {
    ...upstreamsSnapshot,
    me_writers: {
      ...writers,
      writers: writers.writers.map((w) => ({ ...w, rtt_ema_ms: (w.rtt_ema_ms ?? 0) + bump })),
    },
  };
  act(() => latestInstance().emitData("upstreams", next, ts));
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: SSEClient;
let scrolls = 0;

async function mountPage(url = "/pulse/diag/me?tab=writers") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const rootRoute = createRootRoute();
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/pulse/diag/me",
    validateSearch: validateDetailSearch,
    component: () => (
      <DisplayModeProvider>
        <SSEProvider client={client}>
          <MePage />
        </SSEProvider>
      </DisplayModeProvider>
    ),
  });
  const pulseRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pulse", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute, pulseRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await act(async () => {
    root!.render(<RouterProvider router={router as never} />);
    await router.load();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  act(() => latestInstance().emitOpen());
  pushUpstreams(0, TS);
  return container!;
}

function buttons(el: HTMLElement): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll("button"));
}

function byText(el: HTMLElement, text: string): HTMLButtonElement {
  const found = buttons(el).find((b) => (b.textContent ?? "").includes(text));
  if (!found) throw new Error(`no button containing ${text}`);
  return found;
}

/** Opens the writers section if the tab lands on it collapsed. */
function openWriters(el: HTMLElement): void {
  const toggle = el.querySelector<HTMLButtonElement>('button[aria-controls="writers-panel"]');
  if (toggle?.getAttribute("aria-expanded") === "false") act(() => toggle.click());
}

// The surface is a portal into document.body (ui/Sheet), not a child of the
// page container.
function surface(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

// React tracks an input's value on the node itself, so assigning `.value`
// and firing `input` is a no-op it deduplicates away; the native setter is
// what a real keystroke goes through.
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function writerRows(el: HTMLElement): HTMLButtonElement[] {
  const panel = el.querySelector<HTMLElement>("#writers-panel");
  return panel ? Array.from(panel.querySelectorAll<HTMLButtonElement>("button[data-roving-item]")) : [];
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  client = createSSEClient({ eventSourceFactory: fakeEventSourceFactory, debounceMs: 10 });
  scrolls = 0;
  window.scrollTo = () => {
    scrolls += 1;
  };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  if (container) container.remove();
  root = null;
  container = null;
  client.dispose();
  vi.useRealTimers();
});

describe("a realtime frame during interaction (spec §19.1)", () => {
  it("actually lands — the rows show the new numbers", async () => {
    // The control for every other test in this file: a push that changed
    // nothing on screen would make «state survived» meaningless.
    const el = await mountPage();
    openWriters(el);
    const before = writerRows(el)[0].textContent;

    pushUpstreams(5, TS + 30);

    expect(writerRows(el)[0].textContent).not.toBe(before);
  });

  it("does not scroll the page or close an open accordion", async () => {
    const el = await mountPage();
    openWriters(el);
    const opened = el.querySelector<HTMLElement>("#writers-panel")!;
    expect(opened.hidden).toBe(false);
    const before = scrolls;

    pushUpstreams(5, TS + 30);

    expect(el.querySelector<HTMLElement>("#writers-panel")!.hidden).toBe(false);
    // §19.1: "не возвращать scroll наверх" — the page never asks the window
    // to move because a number changed.
    expect(scrolls).toBe(before);
  });

  it("keeps an active search and its result set", async () => {
    const el = await mountPage();
    openWriters(el);
    const search = el.querySelector<HTMLInputElement>('input[type="search"], input[type="text"]');
    if (!search) throw new Error("the 46-writer list must offer a search box (§18.1)");
    const all = writerRows(el).length;
    // One writer's own identity, so the result set is unambiguously narrower
    // than the page's visible limit rather than merely different.
    const identity = writerRows(el)[0].querySelector("span span")!.textContent!;
    type(search, identity);
    const filtered = writerRows(el).length;
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(all);

    pushUpstreams(7, TS + 60);

    const after = el.querySelector<HTMLInputElement>('input[type="search"], input[type="text"]')!;
    expect(after.value).toBe(identity);
    expect(writerRows(el).length).toBe(filtered);
  });

  it("keeps a revealed «Показать ещё» limit instead of collapsing back", async () => {
    const el = await mountPage();
    openWriters(el);
    const before = writerRows(el).length;
    const more = buttons(el).find((b) => (b.textContent ?? "").includes("Показать ещё"));
    if (!more) throw new Error("46 writers must be paged (§18.3)");
    act(() => more.click());
    const revealed = writerRows(el).length;
    expect(revealed).toBeGreaterThan(before);

    pushUpstreams(9, TS + 90);

    expect(writerRows(el).length).toBe(revealed);
  });

  it("keeps an open detail surface on the same entity", async () => {
    const el = await mountPage();
    openWriters(el);
    const row = writerRows(el)[0];
    if (!row) throw new Error("entity rows must be reachable as controls (§21)");
    act(() => row.click());
    expect(surface()).not.toBeNull();
    const identity = surface()!.getAttribute("aria-label");
    expect(identity).toBeTruthy();

    pushUpstreams(11, TS + 120);

    // Same entity, not a jump to whoever is first in the new array (§19.2).
    expect(surface()).not.toBeNull();
    expect(surface()!.getAttribute("aria-label")).toBe(identity);
  });

  it("moves focus nowhere", async () => {
    const el = await mountPage();
    openWriters(el);
    const target = byText(el, "Показать ещё");
    act(() => target.focus());
    expect(document.activeElement).toBe(target);

    pushUpstreams(13, TS + 150);

    expect(document.activeElement).toBe(target);
  });
});
