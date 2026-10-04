import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogStream, type LogStreamClient } from "./logStream";
import { FakeEventSource, fakeEventSourceFactory, latestInstance } from "../realtime/testing/fakeEventSource";

let client: LogStreamClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  client?.close();
  client = null;
  vi.restoreAllMocks();
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

function makeJournalClient(service = "telemt") {
  const sources: JournalEventSource[] = [];
  client = createLogStream(service, { eventSourceFactory: () => {
    const source = new JournalEventSource();
    sources.push(source);
    return source as unknown as EventSource;
  } });
  return sources;
}

describe("createLogStream", () => {
  it.each(["permission_denied", "command_missing"])("keeps %s failures manual until retry", reason => {
    const sources = makeJournalClient();
    sources[0].emit("log_source_error", {
      code: "log_source_error", message: "safe diagnostic", source: "file",
      service: "telemt", target: "/var/log/telemt.log", reason,
    });
    expect(client!.getSnapshot().status).toBe("error");
    expect(client!.getSnapshot().error?.reason).toBe(reason);
    expect(sources[0].closed).toBe(true);
    vi.advanceTimersByTime(90_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sources).toHaveLength(1);
    client!.retry();
    expect(sources).toHaveLength(2);
    expect(client!.getSnapshot().status).toBe("connecting");
    expect(client!.getSnapshot().error).toBeUndefined();
  });

  it("reopens a normally ended source after one second and keeps its line listeners", () => {
    const sources = makeJournalClient("panel");
    const lines: unknown[] = [];
    client!.onLine(line => lines.push(line));
    const first = { ts: "2026-10-03T12:00:00Z", msg: "first line" };
    sources[0].emit("log", first);
    sources[0].emit("log_end", {});
    expect(client!.getSnapshot().status).toBe("reconnecting");
    expect(client!.getSnapshot().error).toBeUndefined();
    expect(sources[0].closed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    const second = { ts: "2026-10-03T12:00:01Z", msg: "second line" };
    sources[1].emit("log", second);
    expect(lines).toEqual([first, second]);
  });

  it("backs off repeated EOFs without frames through 1, 2, 5, 10, and at most 30 seconds", () => {
    const sources = makeJournalClient();
    for (const [index, delay] of [1000, 2000, 5000, 10_000, 30_000, 30_000].entries()) {
      sources[index].emit("open", {});
      sources[index].emit("log_end", {});
      expect(client!.getSnapshot().status).toBe("reconnecting");
      vi.advanceTimersByTime(delay - 1);
      expect(sources).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(sources).toHaveLength(index + 2);
    }
  });

  it.each(["source_timeout", "read_failed", "command_failed", "daemon_unavailable", "target_missing", "file_missing"])("automatically retries %s while retaining its diagnostic", reason => {
    const sources = makeJournalClient();
    sources[0].emit("log_source_error", {
      code: "log_source_error", message: "safe diagnostic", source: "file", service: "telemt", reason,
    });
    expect(client!.getSnapshot().status).toBe("reconnecting");
    expect(client!.getSnapshot().error?.reason).toBe(reason);
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    sources[1].emit("open", {});
    expect(client!.getSnapshot().error?.reason).toBe(reason);
    sources[1].emit("heartbeat", {});
    expect(client!.getSnapshot().error).toBeUndefined();
  });

  it.each(["heartbeat", "log"])("resets backoff after a %s frame", event => {
    const sources = makeJournalClient();
    sources[0].emit("log_end", {});
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    sources[1].emit("log_end", {});
    vi.advanceTimersByTime(2000);
    expect(sources).toHaveLength(3);
    sources[2].emit(event, { ts: "2026-10-03T12:00:00Z", msg: "healthy frame" });
    sources[2].emit("log_end", {});
    vi.advanceTimersByTime(999);
    expect(sources).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(4);
  });

  it("waits while hidden and reconnects immediately when visible", () => {
    const sources = makeJournalClient();
    sources[0].emit("log_end", {});
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
  });

  it("reconnects on visibility before the pending delay expires", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const sources = makeJournalClient();
    sources[0].emit("log_end", {});
    vi.advanceTimersByTime(100);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sources).toHaveLength(2);
  });

  it("close cancels pending reconnects and visibility changes cannot reopen it", () => {
    const sources = makeJournalClient();
    sources[0].emit("log_end", {});
    client!.close();
    vi.advanceTimersByTime(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sources).toHaveLength(1);
  });

  it("manual retry cancels pending reconnects and resets the delay", () => {
    const sources = makeJournalClient();
    sources[0].emit("log_end", {});
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    sources[1].emit("log_end", {});
    client!.retry();
    expect(sources).toHaveLength(3);
    sources[2].emit("log_end", {});
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(4);
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(4);
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
    expect(client.getSnapshot().status).toBe("reconnecting");
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

  it("stops native transport retries while hidden and opens a fresh source immediately on visibility", () => {
    client = makeClient();
    const first = latestInstance();
    const received: unknown[] = [];
    client.onLine(line => received.push(line));
    first.emitOpen();
    const before = { ts: "2026-10-03T12:00:00Z", msg: "before transport failure" };
    first.emitLog(before);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    first.emitError(0);
    expect(first.closed).toBe(true);
    expect(client.getSnapshot().status).toBe("reconnecting");
    first.emitOpen();
    first.emitLog({ ts: "2026-10-03T12:00:01Z", msg: "late frame" });
    vi.advanceTimersByTime(60_000);
    expect(received).toEqual([before]);
    expect(client.getSnapshot().stale).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latestInstance().closed).toBe(false);
    const after = { ts: "2026-10-03T12:00:02Z", msg: "after transport failure" };
    latestInstance().emitOpen();
    latestInstance().emitLog(after);
    expect(received).toEqual([before, after]);
  });

  it.each(["initial connection", "native retry"])("suspends %s when the tab hides before another error event", phase => {
    client = makeClient();
    const first = latestInstance();
    if (phase === "native retry") {
      first.emitOpen();
      first.emitError(0);
      expect(first.closed).toBe(false);
    }
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(first.closed).toBe(true);
    expect(client.getSnapshot().status).toBe("reconnecting");
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("suspends an initial CONNECTING source created while the tab is already hidden", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    client = makeClient();
    expect(latestInstance().closed).toBe(true);
    expect(client.getSnapshot().status).toBe("reconnecting");
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("keeps a healthy OPEN source running when the tab hides", () => {
    client = makeClient();
    const source = latestInstance();
    source.emitOpen();
    const received: unknown[] = [];
    client.onLine(line => received.push(line));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(source.closed).toBe(false);
    expect(client.getSnapshot().status).toBe("open");
    const line = { ts: "2026-10-03T12:00:00Z", msg: "hidden healthy frame" };
    source.emitLog(line);
    expect(received).toEqual([line]);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("close prevents a transport retry suspended while hidden from resuming", () => {
    client = makeClient();
    const first = latestInstance();
    first.emitOpen();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    first.emitError(0);
    expect(first.closed).toBe(true);
    client.close();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("retains a source diagnostic when an automatic connection is suspended while hidden", () => {
    const sources = makeJournalClient();
    sources[0].emit("log_source_error", {
      code: "log_source_error", message: "safe diagnostic", source: "docker",
      service: "telemt", reason: "daemon_unavailable",
    });
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    sources[1].readyState = 0;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sources[1].closed).toBe(true);
    expect(client!.getSnapshot().error?.reason).toBe("daemon_unavailable");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sources).toHaveLength(3);
    expect(client!.getSnapshot().error?.reason).toBe("daemon_unavailable");
    sources[2].emit("heartbeat", {});
    expect(client!.getSnapshot().error).toBeUndefined();
  });

  it("an error with readyState CLOSED (browser gave up) sets status closed", () => {
    client = makeClient();
    latestInstance().emitOpen();
    latestInstance().emitError(2 /* READY_STATE_CLOSED */);
    expect(client.getSnapshot().status).toBe("closed");
  });

  it("does not reopen a permanently CLOSED source on visibility changes", () => {
    client = makeClient();
    latestInstance().emitError(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(client.getSnapshot().status).toBe("closed");
    expect(FakeEventSource.instances).toHaveLength(1);
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
