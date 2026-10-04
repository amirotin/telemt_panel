import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import {
  getGeographyQueryKey,
  getGeographyUsersQueryKey,
} from "../lib/api/generated/@tanstack/react-query.gen";
import { overview } from "./testFixtures";
import { useGeography } from "./useGeography";
import { client as apiClient } from "../lib/api/client";
import { invalidateGeography } from "./queries";

function Probe({ country = null, paused = true }: { country?: string | null; paused?: boolean }) {
  const state = useGeography(
    { range: "now", family: "all", country, location: null, view: "map" },
    paused,
  );
  return (
    <div data-state>
      {JSON.stringify({
        hasData: !!state.base,
        expired: state.expired,
        stale: state.stale,
        error: state.error,
        ips: state.base?.totals?.unique_ips,
      })}
    </div>
  );
}
async function fixture() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const data = overview();
  client.setQueryData(getGeographyQueryKey({ query: { range: "now", family: "all" } }), data);
  const view = document.createElement("div");
  document.body.append(view);
  const root = createRoot(view);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  return { client, data, view, root };
}

it("revokes the whole snapshot after an expired personal-list request", async () => {
  const { client, data, view, root } = await fixture();
  try {
    const key = getGeographyUsersQueryKey({
      query: { snapshot_id: data.snapshot_id, group_id: "city:DE:1" },
    });
    client.setQueryData(key, {
      snapshot_id: data.snapshot_id,
      group_id: "city:DE:1",
      items: [{ username: "private-account", unique_ips: 1 }],
      total: 1,
      next_cursor: null,
    });
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: key,
          queryFn: async () => {
            throw { code: "geography_snapshot_expired", message: "expired" };
          },
          staleTime: 0,
        })
        .catch(() => {});
    });
    expect(view.textContent).toContain('"hasData":false');
    expect(view.textContent).toContain('"expired":true');
    expect(client.getQueryData(key)).toBeUndefined();
  } finally {
    act(() => root.unmount());
    view.remove();
    client.clear();
  }
});

it.each(["geography_source_changed", "geography_snapshot_expired"])(
  "recovers root %s in the background and keeps polling",
  async (code) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const config = apiClient.getConfig();
    let requests = 0;
    const first = overview(),
      next = overview({
        snapshot_id: "00000000000000000000000000000002",
        totals: { unique_ips: 2, accounts: 2, country_count: 1, location_count: 1 },
      });
    apiClient.setConfig({
      baseUrl: "http://localhost",
      fetch: async () =>
        ++requests <= 2
          ? Response.json({ code, message: "retry" }, { status: 409 })
          : Response.json(next),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = getGeographyQueryKey({ query: { range: "now", family: "all" } });
    client.setQueryData(key, first);
    const view = document.createElement("div");
    document.body.append(view);
    const root = createRoot(view);
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Probe paused={false} />
          </QueryClientProvider>,
        ),
      );
      await act(async () => {
        void client.refetchQueries({ queryKey: key, exact: true });
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(view.textContent).toContain('"hasData":true');
      expect(view.textContent).toContain('"stale":true');
      expect(view.textContent).toContain('"error":null');
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(view.textContent).toContain('"hasData":true');
      expect(view.textContent).toContain('"error":null');
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      expect(view.textContent).toContain('"ips":2');
      expect(view.textContent).toContain('"error":null');
      expect(view.textContent).toContain('"expired":false');
      const recoveredRequests = requests;
      await act(async () => vi.advanceTimersByTimeAsync(15000));
      expect(requests).toBeGreaterThan(recoveredRequests);
      expect(view.textContent).toContain('"ips":2');
    } finally {
      act(() => root.unmount());
      view.remove();
      client.clear();
      apiClient.setConfig(config);
      vi.useRealTimers();
    }
  },
);

it("uses monotonic elapsed time for TTL and paused live freshness", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval"] });
  const { client, view, root } = await fixture();
  try {
    await act(async () => vi.setSystemTime(new Date("2099-01-01")));
    expect(view.textContent).toContain('"expired":false');
    await act(async () => vi.advanceTimersByTime(31_000));
    expect(view.textContent).toContain('"stale":true');
    expect(view.textContent).toContain('"expired":false');
    await act(async () => vi.advanceTimersByTime(90_000));
    expect(view.textContent).toContain('"expired":true');
  } finally {
    act(() => root.unmount());
    view.remove();
    client.clear();
    vi.useRealTimers();
  }
});

it("discards the retained frame when settings invalidate the snapshot", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = overview(),
    next = overview({ snapshot_id: "00000000000000000000000000000002" });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const config = apiClient.getConfig();
  apiClient.setConfig({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      const url = new URL((request as Request).url);
      if (url.searchParams.has("snapshot_id")) await delayed;
      return Response.json(next);
    },
  });
  client.setQueryData(getGeographyQueryKey({ query: { range: "now", family: "all" } }), first);
  client.setQueryData(
    getGeographyQueryKey({ query: { snapshot_id: first.snapshot_id, country: "DE" } }),
    first,
  );
  const view = document.createElement("div");
  document.body.append(view);
  const root = createRoot(view);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe country="DE" paused={false} />
        </QueryClientProvider>,
      ),
    );
    expect(view.textContent).toContain('"hasData":true');
    await act(async () => {
      await invalidateGeography(client);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.textContent).toContain('"hasData":false');
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.textContent).toContain('"hasData":true');
  } finally {
    release();
    act(() => root.unmount());
    view.remove();
    client.clear();
    apiClient.setConfig(config);
  }
});

it("still revokes a selected snapshot after its pinned request expires", async () => {
  const config = apiClient.getConfig();
  apiClient.setConfig({
    baseUrl: "http://localhost",
    fetch: async () =>
      Response.json({ code: "geography_snapshot_expired", message: "expired" }, { status: 409 }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = getGeographyQueryKey({ query: { range: "now", family: "all" } });
  client.setQueryData(key, overview());
  const view = document.createElement("div");
  document.body.append(view);
  const root = createRoot(view);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe country="DE" paused={false} />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.textContent).toContain('"hasData":false');
    expect(view.textContent).toContain('"expired":true');
    expect(view.textContent).toContain('"error":"geography_snapshot_expired"');
    expect(client.getQueryData(key)).toBeUndefined();
  } finally {
    act(() => root.unmount());
    view.remove();
    client.clear();
    apiClient.setConfig(config);
  }
});
