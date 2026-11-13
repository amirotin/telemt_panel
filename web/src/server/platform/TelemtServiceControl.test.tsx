import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { TelemtServiceControl } from "./TelemtServiceControl";
import { client as apiClient } from "../../lib/api/client";
import { getTelemtServiceQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import { setLocalePreference } from "../../i18n";

vi.mock("../../ui/Toast", () => ({ pushToast: vi.fn() }));
const initial = {
  service: "telemt", manager: "systemd", status: "stopped" as "running" | "stopped" | "unknown",
  native_state: "inactive", status_supported: true, binding_conflict: false,
  busy: false, caps: { start: true, stop: true, restart: true }, manual_commands: {},
};
const originalConfig = apiClient.getConfig();
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
let root: Root | undefined;
let container: HTMLDivElement;
let cache: QueryClient;
async function setup(data: typeof initial | null = initial) {
  setLocalePreference("ru");
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (data) cache.setQueryData(getTelemtServiceQueryKey(), data);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={cache}><TelemtServiceControl /></QueryClientProvider>); await settle(); });
}
function button(label: string, parent: ParentNode = container) {
  return [...parent.querySelectorAll("button")].find((item) => item.textContent === label)!;
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined; container?.remove(); cache?.clear(); apiClient.setConfig(originalConfig); vi.clearAllMocks();
});

it("keeps actions and confirmation available during an unfinished background refetch", async () => {
  let finishGet!: () => void;
  let finishPost!: () => void;
  let writes = 0;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    if ((request as Request).method === "POST") {
      writes++; await new Promise<void>((resolve) => { finishPost = resolve; });
      return new Response(null, { status: 202 });
    }
    await new Promise<void>((resolve) => { finishGet = resolve; });
    return Response.json(initial);
  } });
  await setup();
  let refresh!: Promise<void>;
  await act(async () => { refresh = cache.refetchQueries({ queryKey: getTelemtServiceQueryKey() }); await settle(); });
  expect(cache.isFetching()).toBe(1);
  expect(button("Запустить").disabled).toBe(false);
  await act(async () => button("Запустить").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(button("Запустить Telemt", dialog).disabled).toBe(false);
  await act(async () => { button("Запустить Telemt", dialog).click(); await settle(); });
  expect(writes).toBe(1);
  expect(button("Перезапустить").disabled).toBe(true);
  await act(async () => { finishGet(); await refresh; finishPost(); await settle(); });
});

it.each([
  ["failed", "stopped", "Сбой"],
  ["activating", "unknown", "Запускается"],
  ["deactivating", "unknown", "Останавливается"],
  ["reloading", "unknown", "Перечитывает конфигурацию"],
] as const)("shows the native %s state without presenting a clean stop", async (native, status, label) => {
  await setup({ ...initial, status, native_state: native });
  expect(container.textContent).toContain(label);
  if (native === "failed") expect(container.querySelector('a[href$="/journal"]')).not.toBeNull();
});

it("blocks initial pending and failed status reads", async () => {
  let fail!: () => void;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async () => {
    await new Promise<void>((resolve) => { fail = resolve; }); throw new Error("offline");
  } });
  await setup(null);
  expect(button("Запустить")).toBeUndefined();
  await act(async () => { fail(); await settle(); });
  expect(button("Запустить").disabled).toBe(true);
});

it("blocks actions while the shared host lock is busy", async () => {
  await setup({ ...initial, busy: true });
  expect(button("Запустить").disabled).toBe(true);
  expect(button("Перезапустить").disabled).toBe(true);
});

it("blocks cached actions after a background status error", async () => {
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async () => { throw new Error("offline"); } });
  await setup();
  await act(async () => { await cache.refetchQueries({ queryKey: getTelemtServiceQueryKey() }); await settle(); });
  expect(button("Запустить").disabled).toBe(true);
  expect(container.textContent).toContain("Статус неизвестен");
});
