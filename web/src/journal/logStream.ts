import { withBasePath } from "../lib/base-path";
import type { LogLine, LogSourceDiagnostic } from "../lib/api/generated/types.gen";
import { logSourceDiagnostic } from "./logSourceDiagnostic";

// DEFAULT_STALE_MS mirrors sseClient.ts's 40s global-stale watchdog
// (02-hub-sse.md's heartbeat contract is shared by /api/events and
// /api/events/logs — see that module's own comment) — reused here as a
// constant rather than an import, since this client otherwise shares no
// code with sseClient.ts's multi-topic multiplexing.
const DEFAULT_STALE_MS = 40_000;

// READY_STATE_CLOSED mirrors the standard EventSource.CLOSED value (2) —
// see sseClient.ts's identical constant for why this isn't a reference to
// the global EventSource.
const READY_STATE_CLOSED = 2;

export type LogStreamStatus = "connecting" | "open" | "reconnecting" | "closed" | "error" | "ended";

export interface LogStreamSnapshot {
  status: LogStreamStatus;
  /** No frame (log line or heartbeat) received for staleMs. */
  stale: boolean;
  error?: LogSourceDiagnostic;
}

export interface LogStreamOptions {
  /** Test seam: defaults to `new EventSource(url, {withCredentials: true})`. */
  eventSourceFactory?: (url: string) => EventSource;
  staleMs?: number;
}

export interface LogStreamClient {
  getSnapshot(): LogStreamSnapshot;
  subscribe(cb: () => void): () => void;
  onLine(cb: (line: LogLine) => void): () => void;
  /** Opens a fresh connection after a source error, normal EOF or transport failure. */
  retry(): void;
  /** Stops the stream for good; no further snapshot/line callbacks fire. */
  close(): void;
}

// createLogStream opens ONE EventSource against GET /api/events/logs
// (02-hub-sse.md §Логи) for `service` and keeps it open until close() is
// called. Unlike sseClient.ts's app-wide, ref-counted, multi-topic client,
// at most one log viewer is ever mounted at a time (the Journal tab), so
// there's no topic union to manage — useLogStream.ts owns exactly one of
// these per (service) and recreates it on service switch or unmount.
//
// Reconnection on a transient drop is left to the browser's own EventSource
// retry (Task 7 brief B: "reconnect via browser") — this client does not
// implement sseClient.ts's own backoff/polling fallback. It only surfaces
// Source errors and normal EOF have named events and stop automatic retries;
// the viewer keeps received lines and exposes an explicit retry action.
// A non-2xx/non-event-stream response (e.g. an expired session) instead sets
// EventSource.readyState to CLOSED with no auto-retry.
export function createLogStream(service: string, options: LogStreamOptions = {}): LogStreamClient {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const eventSourceFactory =
    options.eventSourceFactory ?? ((url: string) => new EventSource(url, { withCredentials: true }));

  const listeners = new Set<() => void>();
  const lineListeners = new Set<(line: LogLine) => void>();
  let snapshot: LogStreamSnapshot = { status: "connecting", stale: false };
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let es: EventSource | null = null;

  function notify() {
    for (const cb of listeners) cb();
  }

  function setSnapshot(patch: Partial<LogStreamSnapshot>) {
    const next: LogStreamSnapshot = { ...snapshot, ...patch };
    if (next.status === snapshot.status && next.stale === snapshot.stale && next.error === snapshot.error) return;
    snapshot = next;
    notify();
  }

  function resetStaleWatchdog() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => setSnapshot({ stale: true }), staleMs);
  }

  function onFrame() {
    resetStaleWatchdog();
    setSnapshot({ stale: false });
  }

  function stopConnection() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
    es?.close();
    es = null;
  }

  function open() {
    if (closed) return;
    const url = `${withBasePath("/api/events/logs")}?service=${encodeURIComponent(service)}`;
    const next = eventSourceFactory(url);
    es = next;

    next.addEventListener("open", () => {
      if (es !== next) return;
      setSnapshot({ status: "open" });
      onFrame();
    });

    next.addEventListener("log", (ev) => {
      if (es !== next) return;
      onFrame();
      const parsed = parseJSON<LogLine>((ev as MessageEvent).data);
      if (!parsed) return;
      for (const cb of lineListeners) cb(parsed);
    });

    next.addEventListener("heartbeat", () => {
      if (es !== next) return;
      onFrame();
    });

    next.addEventListener("log_source_error", (ev) => {
      if (es !== next) return;
      const diagnostic = logSourceDiagnostic(parseJSON<unknown>((ev as MessageEvent).data));
      if (!diagnostic || diagnostic.service !== service) return;
      stopConnection();
      setSnapshot({ status: "error", stale: false, error: diagnostic });
    });

    next.addEventListener("log_end", () => {
      if (es !== next) return;
      stopConnection();
      setSnapshot({ status: "ended", stale: false, error: undefined });
    });

    next.addEventListener("error", () => {
      if (es !== next) return;
      if (next.readyState === READY_STATE_CLOSED) {
        setSnapshot({ status: "closed" });
      } else {
        setSnapshot({ status: "reconnecting" });
      }
    });
  }

  open();

  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onLine(cb) {
      lineListeners.add(cb);
      return () => lineListeners.delete(cb);
    },
    retry() {
      if (closed) return;
      if (es) {
        es.close();
        es = null;
      }
      if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
      setSnapshot({ status: "connecting", stale: false, error: undefined });
      open();
    },
    close() {
      closed = true;
      if (staleTimer) clearTimeout(staleTimer);
      if (es) {
        es.close();
        es = null;
      }
    },
  };
}

function parseJSON<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
