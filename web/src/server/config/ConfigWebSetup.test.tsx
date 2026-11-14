import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigPage } from "./ConfigPage";
import { client } from "../../lib/api/client";
import { getStrings } from "../../i18n";
import { getHostQueryKey, getTelemtInfoQueryKey, getTelemtConfigCatalogQueryKey, getTelemtConfigQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";

vi.mock("../ServerShell", () => ({ ServerShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../useIsDesktop", () => ({ useIsDesktop: () => true }));
const previous = client.getConfig();
const copy = getStrings().server.config;
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); cache?.clear(); client.setConfig(previous); });
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
async function click(label: string) { await act(async () => { button(label).click(); await settle(); }); }

it.each([false, true])("saves a new WEB vhost atomically with the required first profile when enabled=%s", async (enabled) => {
  const existing = { host: "existing.example.com", public_addr: "203.0.113.1:443", decoy: { mode: "http_upstream", upstream: "http://127.0.0.1:9" }, profiles: [{ user: "alice", secret_mode: "plain" }] };
  const initial = { revision: "r1", sections: { server: { listeners: [{ transport: "web" }] }, web: { enabled, vhosts: [existing] } } };
  let submitted: { sections: { web: { vhosts: Record<string, unknown>[] } } } | undefined;
  client.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "PATCH") { submitted = await req.json(); return Response.json({ revision: "r2", changed: ["web.vhosts"] }); }
    if (req.url.endsWith("/api/users")) return Response.json([{ username: "alice" }, { username: "bob" }]);
    if (/\/(state|schema|validate)$/.test(req.url)) return Response.json({ code: "capability_absent" }, { status: 501 });
    if (req.url.endsWith("/catalog")) return Response.json(cache.getQueryData(getTelemtConfigCatalogQueryKey()));
    return Response.json(initial);
  } });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  cache.setQueryData(getTelemtConfigQueryKey(), initial);
  cache.setQueryData(getTelemtInfoQueryKey(), { version: "3.5.17", capabilities: { config_api: true, read_only: false } });
  cache.setQueryData(getHostQueryKey(), { caps: {} });
  const fields = ["web.vhosts", "web.vhosts[].host", "web.vhosts[].hosts", "web.vhosts[].public_addr"].map((path) => ({ path, kind: "string", group: "web", tier: "normal", data_type: "String", default_value: "", doc_hot: true, apply: "runtime reload", secret: false }));
  cache.setQueryData(getTelemtConfigCatalogQueryKey(), { version: "3.5.17", fields, groups: [{ id: "web", title: "WEB", short: "WEB" }] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<QueryClientProvider client={cache}><ConfigPage /></QueryClientProvider>); await settle(); });
  await click(copy.catalog.webAddVhost);
  const input = (label: string, value: string) => {
    const node = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  input(copy.catalog.webDomains, "one.example.com, two.example.com");
  input(copy.catalog.labels["web.vhosts.public_addr"], "203.0.113.2:443");
  expect(button(copy.save).disabled).toBe(enabled);
  if (enabled) {
    await act(async () => { container.querySelector<HTMLInputElement>('input[role="combobox"]')!.focus(); await settle(); });
    input(copy.catalog.webProfilesTitle, "bob");
    act(() => document.querySelector<HTMLElement>('[role="option"][aria-label="bob · plain"]')!.click());
    expect(button(copy.save).disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Удалить профиль bob · plain"]')!.click());
    expect(button(copy.save).disabled).toBe(true);
    input(copy.catalog.webProfilesTitle, "bob");
    act(() => document.querySelector<HTMLElement>('[role="option"][aria-label="bob · plain"]')!.click());
  }
  await click(copy.save);
  await act(async () => { await settle(); });
  const apply = [...document.querySelectorAll("button")].find((item) => item.textContent === copy.savePreview.apply.replace("{count}", "1"))!;
  await act(async () => { apply.click(); await settle(); });
  expect(submitted?.sections.web.vhosts).toHaveLength(2);
  expect(submitted?.sections.web.vhosts[0]).toEqual(existing);
  expect(submitted?.sections.web.vhosts[1]).toEqual({ hosts: ["one.example.com", "two.example.com"], public_addr: "203.0.113.2:443", decoy: { mode: "http_upstream", upstream: "http://127.0.0.1:8080" }, profiles: enabled ? [{ user: "bob", secret_mode: "plain" }] : [] });
});
