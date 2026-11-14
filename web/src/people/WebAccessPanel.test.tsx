import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { WebAccessPanel } from "./WebAccessPanel";
import { client as apiClient } from "../lib/api/client";
import { getTelemtWebAccessQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import { pushToast } from "../ui/Toast";

vi.mock("../ui/Toast", () => ({ pushToast: vi.fn() }));
const config = { revision: "r1", enabled: true, vhosts: [{ host: "example.com", public_addr: "example.com:443", profiles: [{ user: "alice", secret_mode: "plain" }, { user: "bob", secret_mode: "plain" }] }] };
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const originalConfig = apiClient.getConfig();
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;
async function renderPanel(username = "alice") {
  await act(async () => root.render(<QueryClientProvider client={cache}><WebAccessPanel username={username} /></QueryClientProvider>));
}
async function setup() {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(getTelemtWebAccessQueryKey(), config);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await renderPanel(); await act(async () => button("Настроить").click());
}
async function changeMode(value: string) {
  await act(async () => { const mode = document.querySelectorAll("select")[1]!; mode.value = value; mode.dispatchEvent(new Event("change", { bubbles: true })); });
}
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); cache?.clear(); apiClient.setConfig(originalConfig); vi.clearAllMocks(); });

it("shows all group domains while submitting one shared profile identity", async () => {
  let submitted: unknown;
  const grouped = { ...config, vhosts: [{ ...config.vhosts[0], hosts: ["example.com", "alias.example.com"] }] };
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "PUT") { submitted = await req.json(); return Response.json({ revision: "r2", changed: ["web"] }); }
    return Response.json({ ...grouped, revision: "r2" });
  } });
  await setup();
  await act(async () => { cache.setQueryData(getTelemtWebAccessQueryKey(), grouped); await settle(); });
  expect(document.querySelector("select")?.selectedOptions[0]?.textContent).toContain("example.com, alias.example.com");
  await changeMode("dd");
  await act(async () => { button("Сохранить").click(); await settle(); });
  expect(submitted).toEqual({ profiles: [{ vhost: "example.com", secret_mode: "dd" }] });
});

it("keeps an unsaved WEB profile and focus on an unrelated config revision (A05)", async () => {
  await setup(); await changeMode("dd");
  const mode = document.querySelectorAll("select")[1]!; mode.focus();
  await act(async () => { cache.setQueryData(getTelemtWebAccessQueryKey(), { ...config, revision: "r2" }); await settle(); });
  expect(document.querySelectorAll("select")[1]!.value).toBe("dd");
  expect(document.activeElement).toBe(mode);
});

it("recovers an unrelated revision conflict without discarding the WEB draft", async () => {
  const revisions: Array<string | null> = [];
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "PUT") {
      revisions.push(req.headers.get("If-Match"));
      if (revisions.length === 1) return Response.json({ code: "revision_conflict", message: "stale" }, { status: 409 });
      return Response.json({ revision: "r3", changed: ["web"] });
    }
    return Response.json({ ...config, revision: "r2" });
  } });
  await setup(); await changeMode("dd");
  await act(async () => { button("Сохранить").click(); await settle(); });
  expect(document.body.textContent).not.toContain("Настройки изменились на сервере");
  expect(document.querySelectorAll("select")[1]!.value).toBe("dd");
  expect(revisions).toEqual(["r1"]);
  await act(async () => { button("Сохранить").click(); await settle(); });
  expect(revisions).toEqual(["r1", "r2"]);
});

it("requires an explicit rebase before overwriting a real profile conflict", async () => {
  const revisions: Array<string | null> = [];
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "PUT") {
      revisions.push(req.headers.get("If-Match"));
      return revisions.length === 1
        ? Response.json({ code: "revision_conflict", message: "stale" }, { status: 409 })
        : Response.json({ revision: "r3", changed: ["web"] });
    }
    return Response.json({ ...config, revision: "r2", vhosts: [{ ...config.vhosts[0], profiles: [{ user: "alice", secret_mode: "plain", max_sessions: 7 }] }] });
  } });
  await setup(); await changeMode("dd");
  await act(async () => { button("Сохранить").click(); await settle(); });
  expect(document.body.textContent).toContain("Настройки изменились на сервере");
  const rebase = button("Перенести черновик на новую версию");
  expect(rebase).toBeDefined();
  await act(async () => { rebase.click(); await settle(); });
  expect(revisions).toEqual(["r1"]);
  expect(document.querySelectorAll("select")[1]!.value).toBe("dd");
  await act(async () => { button("Сохранить").click(); await settle(); });
  expect(revisions).toEqual(["r1", "r2"]);
});

it("keeps edits made while WEB profiles are saving visible and dirty", async () => {
  let finish!: () => void;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    if ((request as Request).method === "PUT") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ revision: "r2", changed: ["web"] }); }
    return Response.json({ ...config, revision: "r2", vhosts: [{ ...config.vhosts[0], profiles: [{ user: "alice", secret_mode: "dd" }] }] });
  } });
  await setup(); await changeMode("dd");
  await act(async () => { button("Сохранить").click(); await settle(); });
  await changeMode("plain");
  await act(async () => { finish(); await settle(); });
  expect(document.querySelectorAll("select")[1]?.value).toBe("plain");
  expect(button("Сохранить").disabled).toBe(false);
  expect(pushToast).not.toHaveBeenCalled();
});

it.each(["pending", "unknown"] as const)("preserves an edit back to baseline during a %s write", async (outcome) => {
  let release!: () => void;
  let writes = 0;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    if ((request as Request).method === "PUT") {
      writes++;
      await new Promise<void>((resolve) => { release = resolve; });
      return Response.json({ code: "telemt_config_outcome_unknown", message: "unconfirmed" }, { status: 504 });
    }
    return Response.json(config);
  } });
  await setup(); await changeMode("dd");
  await act(async () => { button("Сохранить").click(); await settle(); });
  try {
    if (outcome === "unknown") await act(async () => { release(); await settle(); });
    await changeMode("plain");
    await act(async () => {
      cache.setQueryData(getTelemtWebAccessQueryKey(), { ...config, revision: "r2", vhosts: [{ ...config.vhosts[0], profiles: [{ user: "alice", secret_mode: "dd" }] }] });
      await settle();
    });
    expect(document.querySelectorAll("select")[1]!.value).toBe("plain");
    expect(document.body.textContent).toContain("Настройки изменились на сервере");
    expect(writes).toBe(1);
  } finally { await act(async () => { release(); await settle(); }); }
});

it("ignores an old username save response after switching the editor session", async () => {
  let finish!: () => void;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    if ((request as Request).method === "PUT") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ revision: "r2", changed: ["web"] }); }
    return Response.json(config);
  } });
  await setup(); await changeMode("dd");
  await act(async () => { button("Сохранить").click(); await settle(); });
  await renderPanel("bob"); await changeMode("dd");
  await act(async () => { finish(); await settle(); });
  expect(document.querySelectorAll("select")[1]?.value).toBe("dd");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("bob");
  expect(pushToast).not.toHaveBeenCalled();
});

it("keeps an open dirty WEB profile mounted when a background GET fails", async () => {
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async () => { throw new Error("offline"); } });
  await setup(); await changeMode("dd");
  const mode = document.querySelectorAll("select")[1]!; mode.focus();
  await act(async () => { await cache.refetchQueries({ queryKey: getTelemtWebAccessQueryKey() }); await settle(); });
  expect(document.querySelectorAll("select")[1]?.value).toBe("dd");
  expect(document.activeElement).toBe(mode);
});

it("saves WEB profiles with an explicit drain policy and explains its deadline", async () => {
  let query: URLSearchParams | undefined;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "PUT") { query = new URL(req.url).searchParams; return Response.json({ revision: "r2", changed: ["web"] }); }
    return Response.json({ ...config, revision: "r2" });
  } });
  await setup(); await changeMode("dd");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("соединения");
  await act(async () => { button("Сохранить").click(); await settle(); });
  expect(query?.get("reload")).toBe("drain");
  expect(query?.get("timeout_secs")).toBe("30");
});

it("keeps reload progress visible after the WEB editor closes", async () => {
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "PUT") return Response.json({ revision: "r2", changed: ["web"], reload: { reload_id: 42, state: "accepted", mode: "drain" } });
    if (new URL(req.url).pathname.endsWith("/reload/42")) return Response.json({ reload_id: 42, state: "draining", mode: "drain" });
    return Response.json({ ...config, revision: "r2", vhosts: [{ ...config.vhosts[0], profiles: [{ user: "alice", secret_mode: "dd" }] }] });
  } });
  await setup(); await changeMode("dd");
  await act(async () => { button("Сохранить").click(); await settle(); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[data-testid="web-access-reload"]')?.textContent).toContain("Статус перезагрузки");
});
