import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebEditor } from "./WebEditor";
import { StructuredSettingsForm } from "./StructuredSettingsForm";
import { getStrings } from "../../i18n";
import type { TelemtConfigField } from "../../lib/api/generated/types.gen";

vi.mock("../useIsDesktop", () => ({ useIsDesktop: () => true }));

const field = (path: string): TelemtConfigField => ({ path, kind: "string", group: "web", tier: "normal", data_type: "String", default_value: "", doc_hot: true, apply: "runtime reload", secret: false });
const fields = ["web.vhosts", "web.vhosts[].host", "web.vhosts[].hosts", "web.vhosts[].public_addr"].map(field);
const vhost = { host: "one.example.com", public_addr: "203.0.113.1:443", decoy: { mode: "http_upstream", upstream: "http://127.0.0.1:9" }, profiles: [], future: 42 };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

function input(label: string, value: string) {
  const node = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(node).not.toBeNull();
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
  return node;
}
function Harness({ initial = vhost, enabled = false, supported = true, usernames = ["alice", "bob"], usersPending = false, usersError = false }: {
  initial?: Record<string, unknown>; enabled?: boolean; supported?: boolean; usernames?: string[]; usersPending?: boolean; usersError?: boolean;
}) {
  const [sections, setSections] = useState<Record<string, unknown>>({ server: { listeners: [{ transport: "web" }] }, web: { enabled, vhosts: [initial] } });
  return <><WebEditor fields={supported ? fields : fields.filter((item) => !item.path.endsWith(".hosts"))} sections={sections} advanced={false} onChange={setSections} usernames={usernames} usersPending={usersPending} usersError={usersError} /><output>{JSON.stringify(sections)}</output></>;
}
const snapshot = () => JSON.parse(container.querySelector("output")!.textContent!).web;

function chooseFirstUser(username: string, mode = "plain") {
  const copy = getStrings().server.config.catalog;
  act(() => container.querySelector<HTMLInputElement>('input[role="combobox"]')!.focus());
  input(copy.webProfilesTitle, username);
  const option = document.querySelector<HTMLElement>(`[role="option"][aria-label="${username} · ${mode}"]`)!;
  expect(option).not.toBeNull();
  act(() => option.click());
}

it("keeps a trailing comma while typing and switches one/many domains without both keys", () => {
  act(() => root.render(<Harness />));
  const label = getStrings().server.config.catalog.webDomains;
  expect(input(label, "one.example.com, ").value).toBe("one.example.com, ");
  input(label, "one.example.com, two.example.com");
  expect(snapshot().vhosts[0]).toEqual({ ...vhost, host: undefined, hosts: ["one.example.com", "two.example.com"] });
  expect(snapshot().vhosts[0]).not.toHaveProperty("host");
  input(label, " two.example.com ");
  expect(snapshot().vhosts[0]).toEqual({ ...vhost, host: "two.example.com" });
  expect(snapshot().vhosts[0]).not.toHaveProperty("hosts");
});

it("reads existing host groups and allows WEB enablement when they are complete", () => {
  const group = { ...vhost, host: undefined, hosts: ["one.example.com", "two.example.com"], profiles: [{ user: "alice", secret_mode: "dd" }] };
  act(() => root.render(<Harness initial={group} />));
  const copy = getStrings().server.config.catalog;
  expect(container.querySelector<HTMLInputElement>(`input[aria-label="${copy.webDomains}"]`)?.value).toBe("one.example.com, two.example.com");
  expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.labels["web.enabled"]}"]`)?.disabled).toBe(false);
});

it("retains single-domain editing on older Telemt", () => {
  act(() => root.render(<Harness supported={false} />));
  const label = getStrings().server.config.catalog.labels["web.vhosts.host"];
  input(label, "legacy.example.com");
  expect(snapshot().vhosts[0].host).toBe("legacy.example.com");
  expect(snapshot().vhosts[0]).not.toHaveProperty("hosts");
});

it("allows an empty disabled-WEB vhost and explains the later assignment step", () => {
  act(() => root.render(<Harness />));
  expect(snapshot().vhosts[0].profiles).toEqual([]);
  expect(container.textContent).toContain(getStrings().server.config.catalog.webProfilesLater);
});

it("searches existing users and creates the first profile with the chosen secret mode", () => {
  act(() => root.render(<Harness enabled />));
  const copy = getStrings().server.config.catalog;
  expect(container.textContent).toContain(copy.webFirstProfileRequired);
  input(copy.webProfilesTitle, "BO");
  expect([...document.querySelectorAll('[role="option"]')].map((option) => option.getAttribute("aria-label"))).toEqual(["bob · plain", "bob · dd"]);
  act(() => document.querySelector<HTMLElement>('[role="option"][aria-label="bob · dd"]')!.click());
  expect(snapshot().vhosts[0].profiles).toEqual([{ user: "bob", secret_mode: "dd" }]);
  expect(snapshot().vhosts[0].future).toBe(42);
});

it.each([{ usersPending: true }, { usersError: true }, { usernames: [] }])("never assigns a user when unavailable: %j", (props) => {
  act(() => root.render(<Harness enabled {...props} />));
  act(() => container.querySelector<HTMLInputElement>('input[role="combobox"]')!.focus());
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  expect(snapshot().vhosts[0].profiles).toEqual([]);
});

it("shows existing profiles as removable selections", () => {
  act(() => root.render(<Harness enabled initial={{ ...vhost, profiles: [{ user: "alice", secret_mode: "plain" }] }} />));
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Удалить профиль alice · plain"]');
  expect(remove).not.toBeNull();
  act(() => remove!.click());
  expect(snapshot().vhosts[0].profiles).toEqual([]);
});

it("keeps the initial profile editable after collapsing and reopening an unsaved vhost", () => {
  act(() => root.render(<Harness enabled />));
  chooseFirstUser("bob");
  const copy = getStrings().server.config.catalog;
  act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.collapseRecord}"]`)!.click());
  act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.expandRecord}"]`)!.click());
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Удалить профиль bob · plain"]');
  expect(remove).not.toBeNull();
  act(() => remove!.click());
  chooseFirstUser("alice");
  expect(snapshot().vhosts[0].profiles).toEqual([{ user: "alice", secret_mode: "plain" }]);
});

it("keeps initial profile editing when navigating between configuration groups", () => {
  const model = { version: "3.5.17", fields, source_commit: "test", documented_fields: fields.length, runtime_additions: [], groups: [{ id: "web", title: "WEB", short: "WEB" }, { id: "routing", title: "Other", short: "Other" }] };
  function GroupsHarness() {
    const [sections, setSections] = useState<Record<string, unknown>>({ web: { enabled: true, vhosts: [vhost] } });
    return <StructuredSettingsForm catalog={model} sections={sections} mode="normal" webUsers={{ usernames: ["alice", "bob"] }} onChange={setSections} />;
  }
  act(() => root.render(<GroupsHarness />));
  chooseFirstUser("bob");
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Other"))!.click());
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("WEB"))!.click());
  expect(container.querySelector('button[aria-label="Удалить профиль bob · plain"]')).not.toBeNull();
  expect(container.querySelector('input[role="combobox"]')).not.toBeNull();
});

it("resynchronizes the domain input on an external draft reset", () => {
  let sections: Record<string, unknown> = { web: { vhosts: [vhost] } };
  const render = () => root.render(<WebEditor fields={fields} sections={sections} advanced={false} onChange={(next) => { sections = next; render(); }} />);
  act(render);
  const label = getStrings().server.config.catalog.webDomains;
  input(label, "one.example.com, two.example.com");
  sections = { web: { vhosts: [vhost] } };
  act(render);
  expect(container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe("one.example.com");
});

it("keeps domains attached to the correct record after duplication and removal", () => {
  act(() => root.render(<Harness />));
  const copy = getStrings().server.config.catalog;
  input(copy.webDomains, "one.example.com, alias.example.com");
  act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.duplicateRecord}"]`)!.click());
  input(copy.webDomains, "other.example.com, second.example.com");
  act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.deleteRecord}"]`)!.click());
  expect(snapshot().vhosts).toHaveLength(1);
  expect(snapshot().vhosts[0].hosts).toEqual(["other.example.com", "second.example.com"]);
  expect(container.querySelector<HTMLInputElement>(`input[aria-label="${copy.webDomains}"]`)?.value).toBe("other.example.com, second.example.com");
});

it("keeps one domain control in advanced search and cannot produce both host and hosts", () => {
  const model = { version: "3.5.17", fields, source_commit: "test", documented_fields: fields.length, runtime_additions: [], groups: [{ id: "web", title: "WEB", short: "WEB" }] };
  function SearchHarness() {
    const [sections, setSections] = useState<Record<string, unknown>>({ web: { vhosts: [vhost] } });
    return <><StructuredSettingsForm catalog={model} sections={sections} mode="advanced" onChange={setSections} /><output>{JSON.stringify(sections)}</output></>;
  }
  act(() => root.render(<SearchHarness />));
  const copy = getStrings().server.config.catalog;
  input(copy.searchLabel, "vhosts");
  expect(container.querySelectorAll(`input[aria-label="${copy.webDomains}"]`)).toHaveLength(1);
  input(copy.webDomains, "one.example.com, two.example.com");
  expect(snapshot().vhosts[0].hosts).toEqual(["one.example.com", "two.example.com"]);
  expect(snapshot().vhosts[0]).not.toHaveProperty("host");
});
