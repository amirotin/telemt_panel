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

class JournalEventSource extends EventTarget {
  readyState = 1;
  closed = false;
  close() { this.closed = true; this.readyState = 2; }
  emit(name: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

describe("createLogStream", () => {
  it("retains a source diagnostic and stops automatic retries until a visible retry", () => {
    const sources: JournalEventSource[] = [];
    client = createLogStream("telemt", { eventSourceFactory: () => {
      const source = new JournalEventSource();
      sources.push(source);
      return source as unknown as EventSource;
    } });
    sources[0].emit("log_source_error", {
      code: "log_source_error", message: "Log file is missing", source: "file",
      service: "telemt", target: "/var/log/telemt.log", reason: "file_missing",
    });
    expect(client.getSnapshot().status).toBe("error");
    expect(client.getSnapshot().error?.reason).toBe("file_missing");
    expect(sources[0].closed).toBe(true);
    client.retry();
    expect(sources).toHaveLength(2);
    expect(client.getSnapshot().status).toBe("connecting");
    expect(client.getSnapshot().error).toBeUndefined();
  });

  it("distinguishes normal source EOF from transport reconnection", () => {
    const source = new JournalEventSource();
    client = createLogStream("panel", { eventSourceFactory: () => source as unknown as EventSource });
    source.emit("log_end", {});
    expect(client.getSnapshot().status).toBe("ended");
    expect(client.getSnapshot().error).toBeUndefined();
    expect(source.closed).toBe(true);
  });

  it("ignores malformed and wrong-service source errors", () => {
    const source = new JournalEventSource();
    client = createLogStream("telemt", { eventSourceFactory: () => source as unknown as EventSource });
    source.emit("log_source_error", { code: "log_source_error", reason: "file_missing" });
    source.emit("log_source_error", {
      code: "log_source_error", message: "safe", source: "file", service: "panel", reason: "file_missing",
    });
    expect(client.getSnapshot().error).toBeUndefined();
    expect(source.closed).toBe(false);
  });

  it("ignores late frames from a source stopped by a diagnostic", () => {
    const source = new JournalEventSource();
    client = createLogStream("telemt", { eventSourceFactory: () => source as unknown as EventSource });
    const lines: unknown[] = [];
    client.onLine(line => lines.push(line));
    source.emit("log_source_error", {
      code: "log_source_error", message: "safe", source: "file", service: "telemt", reason: "file_missing",
    });
    source.emit("log", { ts: "2026-10-03T12:00:00Z", msg: "late line" });
    source.emit("log_end", {});
    expect(lines).toEqual([]);
    expect(client.getSnapshot().status).toBe("error");
  });

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
