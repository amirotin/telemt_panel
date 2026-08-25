import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSEClient, type SSEClient } from "./sseClient";

// FakeEventSource stands in for the browser's EventSource: enough of the
// interface (addEventListener/removeEventListener/close/readyState/url) for
// sseClient.ts, plus test-only `emit*` helpers to drive it deterministically
// under fake timers — no real network, no jsdom EventSource dependency.
const READY_STATE_CONNECTING = 0;
const READY_STATE_OPEN = 1;
const READY_STATE_CLOSED = 2;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset() {
    FakeEventSource.instances = [];
  }

  url: string;
  readyState = READY_STATE_CONNECTING;
  closed = false;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (ev: MessageEvent) => void) {
    this.listeners.get(type)?.delete(cb);
  }

  close() {
    this.closed = true;
    this.readyState = READY_STATE_CLOSED;
  }

  emitOpen() {
    this.readyState = READY_STATE_OPEN;
    this.dispatch("open", {} as MessageEvent);
  }

  emitData(topic: string, v: unknown, ts: number) {
    this.dispatch(topic, { data: JSON.stringify({ v, ts }) } as MessageEvent);
  }

  emitHeartbeat() {
    this.dispatch("heartbeat", { data: "{}" } as MessageEvent);
  }

  emitSourceError(topic: string, code: string) {
    this.dispatch("source_error", { data: JSON.stringify({ topic, code }) } as MessageEvent);
  }

  emitError(readyState: number) {
    this.readyState = readyState;
    this.dispatch("error", {} as MessageEvent);
  }

  private dispatch(type: string, ev: MessageEvent) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const cb of [...set]) cb(ev);
  }
}

function latestInstance(): FakeEventSource {
  const instance = FakeEventSource.instances.at(-1);
  if (!instance) throw new Error("no FakeEventSource created yet");
  return instance;
}

function makeClient(overrides: Partial<Parameters<typeof createSSEClient>[0]> = {}): SSEClient {
  return createSSEClient({
    eventSourceFactory: (url) => new FakeEventSource(url) as unknown as EventSource,
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
    expect(fetchSnapshot).not.toHaveBeenCalled();
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
