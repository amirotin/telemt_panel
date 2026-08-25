import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSEClient, type SSEClient } from "./sseClient";
import { FakeEventSource, fakeEventSourceFactory, latestInstance } from "./testing/fakeEventSource";

function makeClient(overrides: Partial<Parameters<typeof createSSEClient>[0]> = {}): SSEClient {
  return createSSEClient({
    eventSourceFactory: fakeEventSourceFactory,
    debounceMs: 10,
    ...overrides,
  });
}

let client: SSEClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
});

afterEach(() => {
  client?.dispose();
  client = null;
  vi.useRealTimers();
});

describe("subscribe/unsubscribe ref-counting and URL rebuild", () => {
  it("does not open a connection until a topic is subscribed", () => {
    client = makeClient();
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it("opens one connection for the union of subscribed topics", async () => {
    client = makeClient();
    client.subscribeTopic("stats");
    client.subscribeTopic("users");
    await vi.advanceTimersByTimeAsync(20);

    expect(FakeEventSource.instances.length).toBe(1);
    expect(latestInstance().url).toContain("topics=stats,users");
  });

  it("shares one connection across multiple subscribers of the same topic", async () => {
    client = makeClient();
    const unsubA = client.subscribeTopic("stats");
    const unsubB = client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeEventSource.instances.length).toBe(1);

    // Dropping one of two subscribers must not tear the connection down.
    unsubA();
    await vi.advanceTimersByTimeAsync(20);
    expect(latestInstance().closed).toBe(false);
    expect(latestInstance().url).toContain("topics=stats");

    unsubB();
    await vi.advanceTimersByTimeAsync(20);
    expect(latestInstance().closed).toBe(true);
  });

  it("debounces rapid subscribe/unsubscribe churn into a single rebuild", async () => {
    client = makeClient({ debounceMs: 50 });
    const unsub = client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(10);
    unsub();
    await vi.advanceTimersByTimeAsync(10);
    client.subscribeTopic("runtime");
    await vi.advanceTimersByTimeAsync(60);

    // Only the final topic set (runtime) should ever have been connected to.
    expect(FakeEventSource.instances.length).toBe(1);
    expect(latestInstance().url).toContain("topics=runtime");
  });

  it("rebuilds the URL when the topic set changes", async () => {
    client = makeClient();
    const unsubStats = client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);
    expect(latestInstance().url).toContain("topics=stats");

    unsubStats();
    client.subscribeTopic("security");
    await vi.advanceTimersByTimeAsync(20);

    expect(FakeEventSource.instances.length).toBe(2);
    expect(latestInstance().url).toContain("topics=security");
    expect(latestInstance().url).not.toContain("stats");
  });

  it("closes the connection once the last subscriber unsubscribes", async () => {
    client = makeClient();
    const unsub = client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);
    unsub();
    await vi.advanceTimersByTimeAsync(20);

    expect(latestInstance().closed).toBe(true);
    expect(client.getConnectionSnapshot().status).toBe("closed");
  });
});

describe("snapshot store", () => {
  it("updates a topic's snapshot on a data event and keeps it on later staleness", async () => {
    client = makeClient();
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);
    const es = latestInstance();

    es.emitData("stats", { health: { status: "ok" } }, 1755950000);

    const snap = client.getTopicSnapshot("stats");
    expect(snap.data).toEqual({ health: { status: "ok" } });
    expect(snap.ts).toBe(1755950000);
    expect(snap.stale).toBe(false);
    expect(snap.error).toBeNull();

    // A later source_error must not clear the previously-received data.
    es.emitSourceError("stats", "telemt_unreachable");
    const afterError = client.getTopicSnapshot("stats");
    expect(afterError.data).toEqual({ health: { status: "ok" } });
    expect(afterError.stale).toBe(true);
    expect(afterError.error).toBe("telemt_unreachable");
  });

  it("notifies only listeners of the topic that changed", async () => {
    client = makeClient();
    client.subscribeTopic("stats");
    client.subscribeTopic("users");
    await vi.advanceTimersByTimeAsync(20);
    const es = latestInstance();

    const statsListener = vi.fn();
    const usersListener = vi.fn();
    client.subscribeTopicListener("stats", statsListener);
    client.subscribeTopicListener("users", usersListener);

    es.emitData("stats", { a: 1 }, 1);

    expect(statsListener).toHaveBeenCalledOnce();
    expect(usersListener).not.toHaveBeenCalled();
  });
});

describe("heartbeat and 40s global staleness", () => {
  it("heartbeat frames keep the connection from going stale", async () => {
    client = makeClient({ staleMs: 40_000 });
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);
    latestInstance().emitOpen();

    await vi.advanceTimersByTimeAsync(30_000);
    latestInstance().emitHeartbeat();
    await vi.advanceTimersByTimeAsync(30_000);
    latestInstance().emitHeartbeat();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(client.getConnectionSnapshot().stale).toBe(false);
  });

  it("goes stale after 40s with no frame at all", async () => {
    client = makeClient({ staleMs: 40_000 });
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);
    latestInstance().emitOpen();

    await vi.advanceTimersByTimeAsync(40_000);

    expect(client.getConnectionSnapshot().stale).toBe(true);
  });

  it("reconnecting (a fresh frame) clears global staleness", async () => {
    client = makeClient({ staleMs: 40_000 });
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);
    latestInstance().emitOpen();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(client.getConnectionSnapshot().stale).toBe(true);

    latestInstance().emitData("stats", { a: 1 }, 1);
    expect(client.getConnectionSnapshot().stale).toBe(false);
  });
});

describe("source_error", () => {
  it("marks only the erroring topic stale, leaving others untouched", async () => {
    client = makeClient();
    client.subscribeTopic("stats");
    client.subscribeTopic("users");
    await vi.advanceTimersByTimeAsync(20);
    const es = latestInstance();

    es.emitData("users", { list: [] }, 1);
    es.emitSourceError("stats", "telemt_unreachable");

    expect(client.getTopicSnapshot("stats").stale).toBe(true);
    expect(client.getTopicSnapshot("stats").error).toBe("telemt_unreachable");
    expect(client.getTopicSnapshot("users").stale).toBe(false);
    expect(client.getTopicSnapshot("users").error).toBeNull();
  });
});

describe("fallback polling after persistent failures", () => {
  it("starts polling GET /api/snapshot after more than 3 consecutive failures", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      stats: { v: { health: { status: "ok" } }, ts: 123 },
    });
    client = makeClient({ failureThreshold: 3, pollIntervalMs: 5_000, fetchSnapshot });
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);

    // Fail 4 times (> threshold of 3); each CLOSED failure schedules its
    // own exponential backoff reconnect, so advance past it each time.
    for (let i = 0; i < 4; i++) {
      latestInstance().emitError(2 /* CLOSED */);
      await vi.advanceTimersByTimeAsync(31_000);
    }

    expect(client.getConnectionSnapshot().status).toBe("polling");
    expect(fetchSnapshot).toHaveBeenCalled();
    expect(client.getTopicSnapshot("stats").data).toEqual({ health: { status: "ok" } });
  });

  it("does not start polling at or below the failure threshold", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({});
    client = makeClient({ failureThreshold: 3, pollIntervalMs: 5_000, fetchSnapshot });
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);

    for (let i = 0; i < 3; i++) {
      latestInstance().emitError(2 /* CLOSED */);
      await vi.advanceTimersByTimeAsync(31_000);
    }

    expect(client.getConnectionSnapshot().status).not.toBe("polling");
    // The very first of the 3 failures fires the immediate first-failure
    // probe (F3) — a single fetchSnapshot call, distinct from the polling
    // fallback's own repeated calls, which never start here.
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("retry() forces an immediate rebuild and resets the failure count", async () => {
    client = makeClient();
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);
    const first = latestInstance();

    first.emitError(2 /* CLOSED */);
    client.retry();
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeEventSource.instances.length).toBe(2);
    expect(latestInstance()).not.toBe(first);
  });

  it("resets the failure counter on success, requiring a fresh streak to trigger polling", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      stats: { v: { health: { status: "ok" } }, ts: 1 },
    });
    client = makeClient({ failureThreshold: 3, pollIntervalMs: 5_000, fetchSnapshot });
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);

    // Fail twice — below the threshold.
    for (let i = 0; i < 2; i++) {
      latestInstance().emitError(2 /* CLOSED */);
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(client.getConnectionSnapshot().status).not.toBe("polling");

    // Recover — this must reset the consecutive-failure counter.
    latestInstance().emitOpen();
    expect(client.getConnectionSnapshot().status).toBe("open");

    // Two more failures alone must NOT cross the threshold post-reset.
    for (let i = 0; i < 2; i++) {
      latestInstance().emitError(2 /* CLOSED */);
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(client.getConnectionSnapshot().status).not.toBe("polling");
    // Two probe calls so far: one for the first streak's first failure,
    // one for this second streak's first failure (F3 fires per streak, on
    // consecutiveFailures===1, not just once ever) — still well short of
    // the polling fallback actually starting.
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    // A fresh streak of 4 (> threshold of 3) does trigger polling.
    for (let i = 0; i < 4; i++) {
      latestInstance().emitError(2 /* CLOSED */);
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(client.getConnectionSnapshot().status).toBe("polling");
    expect(fetchSnapshot).toHaveBeenCalled();

    // Recovering again stops the fallback poll.
    latestInstance().emitOpen();
    expect(client.getConnectionSnapshot().status).toBe("open");
  });
});

// F3 (closing fix wave): an expired session must reach the SDK client's 401
// response interceptor (→ /login redirect) via an immediate probe fetch on
// the very first CLOSED SSE failure, not only after backoff exhausts
// several reconnect attempts (~14s).
describe("first-failure probe (F3)", () => {
  it("fires exactly one immediate snapshot fetch on the first CLOSED failure, none on the next", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({});
    client = makeClient({ fetchSnapshot });
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);

    latestInstance().emitError(2 /* CLOSED */);
    // The probe is fired synchronously off the error handler — no timer
    // advance needed for the call itself, only to flush its microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchSnapshot).toHaveBeenCalledWith(["stats"]);

    // Second consecutive failure (same streak) must not probe again.
    await vi.advanceTimersByTimeAsync(2_000);
    latestInstance().emitError(2 /* CLOSED */);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a transient network error from the probe does not disrupt backoff/reconnect", async () => {
    const fetchSnapshot = vi.fn().mockRejectedValue(new Error("network error"));
    client = makeClient({ fetchSnapshot });
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);

    latestInstance().emitError(2 /* CLOSED */);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    // Swallowed like any other fetchAndInstall failure — status stays
    // "reconnecting", not stuck, and the normal backoff reconnect below
    // still runs on schedule.
    expect(client.getConnectionSnapshot().status).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeEventSource.instances.length).toBe(2);
  });

  it("a 401 response reaching the real fetch path triggers the SDK client's login redirect", async () => {
    const { client: apiClient } = await import("../lib/api/client");
    const { setRouterInstance } = await import("../lib/router-instance");
    const previousFetch = globalThis.fetch;
    const previousConfig = apiClient.getConfig();

    const navigate = vi.fn();
    setRouterInstance({ navigate } as unknown as Parameters<typeof setRouterInstance>[0]);
    // buildUrl needs an absolute base to construct a real Request in this
    // (non-browser) test environment — production always has one via the
    // page's own origin.
    apiClient.setConfig({ baseUrl: "http://panel.test" });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { code: "session_expired" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    try {
      // No fetchSnapshot override — exercises the real defaultFetchSnapshot
      // -> generated getSnapshot() -> the same `client` instance client.ts
      // registers its 401 interceptor on.
      client = makeClient();
      client.subscribeTopic("stats");
      await vi.advanceTimersByTimeAsync(20);
      latestInstance().emitError(2 /* CLOSED */);
      // Flush the probe's fetch -> interceptor -> navigate promise chain.
      for (let i = 0; i < 10 && navigate.mock.calls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate.mock.calls[0][0]).toMatchObject({ to: "/login" });
    } finally {
      globalThis.fetch = previousFetch;
      apiClient.setConfig(previousConfig);
    }
  });
});

describe("refreshTopic (manual per-topic refresh, fix round 1)", () => {
  it("fetches the given topic and installs the result into the snapshot store", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      users: { v: { users: [{ username: "alice" }] }, ts: 42 },
    });
    client = makeClient({ fetchSnapshot });
    client.subscribeTopic("users");
    await vi.advanceTimersByTimeAsync(20);
    fetchSnapshot.mockClear();

    await client.refreshTopic("users");

    expect(fetchSnapshot).toHaveBeenCalledWith(["users"]);
    expect(client.getTopicSnapshot("users").data).toEqual({ users: [{ username: "alice" }] });
  });

  it("notifies topic listeners subscribed to the refreshed topic", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      users: { v: { users: [] }, ts: 1 },
    });
    client = makeClient({ fetchSnapshot });
    client.subscribeTopic("users");
    const listener = vi.fn();
    client.subscribeTopicListener("users", listener);
    await vi.advanceTimersByTimeAsync(20);
    listener.mockClear();

    await client.refreshTopic("users");

    expect(listener).toHaveBeenCalled();
  });

  it("only refreshes the requested topic, leaving others untouched", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      users: { v: { users: ["refreshed"] }, ts: 2 },
    });
    client = makeClient({ fetchSnapshot });
    client.subscribeTopic("users");
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);

    await client.refreshTopic("users");

    expect(fetchSnapshot).toHaveBeenCalledWith(["users"]);
    expect(client.getTopicSnapshot("stats").data).toBeNull();
  });

  it("resolves without throwing when the fetch fails, leaving prior data in place", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({
      users: { v: { users: ["seed"] }, ts: 1 },
    });
    client = makeClient({ fetchSnapshot });
    client.subscribeTopic("users");
    // Seed real data via a successful refresh first — subscribeTopic alone
    // only opens the SSE connection; it does not go through fetchSnapshot.
    await client.refreshTopic("users");
    expect(client.getTopicSnapshot("users").data).toEqual({ users: ["seed"] });

    fetchSnapshot.mockRejectedValueOnce(new Error("network"));
    await expect(client.refreshTopic("users")).resolves.toBeUndefined();
    expect(client.getTopicSnapshot("users").data).toEqual({ users: ["seed"] });
  });
});

describe("reset (logout)", () => {
  it("closes the connection and clears cached snapshots", async () => {
    client = makeClient();
    client.subscribeTopic("stats");
    await vi.advanceTimersByTimeAsync(20);
    latestInstance().emitData("stats", { a: 1 }, 1);
    expect(client.getTopicSnapshot("stats").data).not.toBeNull();

    client.reset();

    expect(client.getTopicSnapshot("stats").data).toBeNull();
    expect(client.getConnectionSnapshot()).toEqual({ status: "closed", stale: false });
  });
});

describe("late snapshot fetches after teardown", () => {
  it("ignores a probe that resolves after reset()", async () => {
    let resolveFetch: (v: Record<string, { v: unknown; ts: number }>) => void = () => {};
    const fetchSnapshot = vi.fn(
      () => new Promise<Record<string, { v: unknown; ts: number }>>((r) => { resolveFetch = r; }),
    );
    const c = makeClient({ fetchSnapshot: fetchSnapshot as never });
    const p = c.refreshTopic("stats");
    c.reset();
    resolveFetch({ stats: { v: { late: true }, ts: 1 } });
    await p;
    expect(c.getTopicSnapshot("stats").data).toBeNull();
    c.dispose();
  });
});
