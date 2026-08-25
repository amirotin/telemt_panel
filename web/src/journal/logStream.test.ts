import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogStream, type LogStreamClient } from "./logStream";
import { FakeEventSource, fakeEventSourceFactory, latestInstance } from "../realtime/testing/fakeEventSource";

let client: LogStreamClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
});

afterEach(() => {
  client?.close();
  client = null;
  vi.useRealTimers();
});

function makeClient(service = "telemt") {
  return createLogStream(service, { eventSourceFactory: fakeEventSourceFactory, staleMs: 1000 });
}

describe("createLogStream", () => {
  it("opens an EventSource against /api/events/logs?service=<service> immediately", () => {
    client = makeClient("panel");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latestInstance().url).toContain("/api/events/logs");
    expect(latestInstance().url).toContain("service=panel");
  });

  it("reports status open on the open event", () => {
    client = makeClient();
    expect(client.getSnapshot().status).toBe("connecting");
    latestInstance().emitOpen();
    expect(client.getSnapshot().status).toBe("open");
  });

  it("delivers parsed LogLine payloads to onLine listeners", () => {
    client = makeClient();
    const received: unknown[] = [];
    client.onLine((line) => received.push(line));
    const line = { ts: "2026-08-25T12:00:00Z", level: "error", msg: "boom" };
    latestInstance().emitLog(line);
    expect(received).toEqual([line]);
  });

  it("a heartbeat resets the stale watchdog without touching status", () => {
    client = makeClient();
    latestInstance().emitOpen();
    vi.advanceTimersByTime(900);
    latestInstance().emitHeartbeat();
    vi.advanceTimersByTime(900);
    expect(client.getSnapshot().stale).toBe(false);
    expect(client.getSnapshot().status).toBe("open");
  });

  it("goes stale after staleMs with no frames at all", () => {
    client = makeClient();
    latestInstance().emitOpen();
    vi.advanceTimersByTime(1000);
    expect(client.getSnapshot().stale).toBe(true);
  });

  it("a log line also resets the stale watchdog and clears stale", () => {
    client = makeClient();
    latestInstance().emitOpen();
    vi.advanceTimersByTime(1000);
    expect(client.getSnapshot().stale).toBe(true);
    latestInstance().emitLog({ ts: "2026-08-25T12:00:00Z", msg: "x" });
    expect(client.getSnapshot().stale).toBe(false);
  });

  it("an error while the browser is still retrying (readyState CONNECTING) sets status reconnecting", () => {
    client = makeClient();
    latestInstance().emitOpen();
    latestInstance().emitError(0 /* READY_STATE_CONNECTING */);
    expect(client.getSnapshot().status).toBe("reconnecting");
  });

  it("an error with readyState CLOSED (browser gave up) sets status closed", () => {
    client = makeClient();
    latestInstance().emitOpen();
    latestInstance().emitError(2 /* READY_STATE_CLOSED */);
    expect(client.getSnapshot().status).toBe("closed");
  });

  it("retry() opens a fresh EventSource after a closed status", () => {
    client = makeClient();
    latestInstance().emitError(2);
    expect(client.getSnapshot().status).toBe("closed");
    client.retry();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(client.getSnapshot().status).toBe("connecting");
  });

  it("close() closes the underlying EventSource and stops further updates", () => {
    client = makeClient();
    const instance = latestInstance();
    client.close();
    expect(instance.closed).toBe(true);

    const before = client.getSnapshot();
    instance.emitOpen();
    expect(client.getSnapshot()).toEqual(before);
  });

  it("close() prevents a subsequent retry() from reopening", () => {
    client = makeClient();
    client.close();
    client.retry();
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
