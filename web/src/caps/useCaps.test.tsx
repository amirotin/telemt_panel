import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client } from "../lib/api/client";
import { getTelemtInfoQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import { useCaps } from "./useCaps";

let root: Root;
let container: HTMLElement;
let queryClient: QueryClient;
let originalFetch: typeof globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function Gates() {
  const caps = useCaps();
  return <>
    <button disabled={!caps.data?.capabilities.rotate_secret}>Rotate</button>
    <button disabled={!caps.data?.capabilities.user_enable_disable}>Enable</button>
  </>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
  focusManager.setFocused(true);
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({
    reachable: true,
    version: "3.5.5",
    capabilities: {
      quota: true, runtime_edge: true, reload_api: true, config_api: true,
      user_enable_disable: true, rotate_secret: true,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  client.setConfig({ baseUrl: "http://panel.test", fetch: fetchMock as typeof globalThis.fetch });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClient.setQueryData(getTelemtInfoQueryKey(), {
    reachable: true, version: "3.5.0",
    capabilities: { user_enable_disable: false, rotate_secret: false },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<QueryClientProvider client={queryClient}><Gates /></QueryClientProvider>));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  client.setConfig({ baseUrl: "", fetch: originalFetch });
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

function gatesDisabled() {
  return [...container.querySelectorAll("button")].map((button) => button.disabled);
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

it("recovers mounted mutation gates after an upgrade without navigation or reload", async () => {
  expect(gatesDisabled()).toEqual([true, true]);
  await advance(5 * 60_000 - 1);
  expect(gatesDisabled()).toEqual([true, true]);
  await advance(1);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(queryClient.getQueryData<{ version: string }>(getTelemtInfoQueryKey())?.version).toBe("3.5.5");
  await advance(1);
  expect(gatesDisabled()).toEqual([false, false]);
});

it("pauses interval requests while hidden and refreshes stale gates on focus", async () => {
  focusManager.setFocused(false);
  await advance(10 * 60_000);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(gatesDisabled()).toEqual([true, true]);
  await act(async () => { focusManager.setFocused(true); });
  await advance(0);
  expect(gatesDisabled()).toEqual([false, false]);
});
