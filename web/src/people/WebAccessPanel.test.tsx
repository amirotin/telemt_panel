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

it("keeps an unsaved WEB profile and focus on an unrelated config revision (A05)", async () => {
  await setup(); await changeMode("dd");
  const mode = document.querySelectorAll("select")[1]!; mode.focus();
  await act(async () => { cache.setQueryData(getTelemtWebAccessQueryKey(), { ...config, revision: "r2" }); await settle(); });
  expect(document.querySelectorAll("select")[1]!.value).toBe("dd");
  expect(document.activeElement).toBe(mode);
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
