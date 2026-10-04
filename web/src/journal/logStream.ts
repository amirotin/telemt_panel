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
const READY_STATE_CONNECTING = 0;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];
const TRANSIENT_SOURCE_REASONS = new Set([
  "source_timeout", "read_failed", "command_failed", "daemon_unavailable", "target_missing", "file_missing",
]);

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
// Visible transport reconnection is left to the browser's EventSource retry.
// CONNECTING sources pause while hidden and reopen immediately on visibility;
// healthy OPEN sources keep streaming in the background.
// Normal EOF and transient source errors reopen with capped backoff while
// the tab is visible; configuration errors require an explicit retry.
// The viewer keeps received lines and shows source errors until a new frame.
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
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectPending = false;
  let reconnectStep = 0;
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
    reconnectStep = 0;
    resetStaleWatchdog();
    setSnapshot({ stale: false, error: undefined });
  }

  function stopConnection() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
    es?.close();
    es = null;
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function reconnect() {
    clearReconnectTimer();
    if (closed || !reconnectPending || document.visibilityState === "hidden") return;
    reconnectPending = false;
    open();
  }

  function scheduleReconnect() {
    reconnectPending = true;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectStep, RECONNECT_DELAYS_MS.length - 1)];
    reconnectStep = Math.min(reconnectStep + 1, RECONNECT_DELAYS_MS.length - 1);
    setSnapshot({ status: "reconnecting", stale: false });
    if (document.visibilityState !== "hidden") reconnectTimer = setTimeout(reconnect, delay);
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      clearReconnectTimer();
      pauseConnecting();
    }
    else if (reconnectPending) reconnect();
  }

  function pauseConnecting() {
    if (es?.readyState !== READY_STATE_CONNECTING) return;
    stopConnection();
    reconnectPending = true;
    setSnapshot({ status: "reconnecting", stale: false });
  }

  function open() {
    if (closed) return;
    const url = `${withBasePath("/api/events/logs")}?service=${encodeURIComponent(service)}`;
    const next = eventSourceFactory(url);
    es = next;

    next.addEventListener("open", () => {
      if (es !== next) return;
      setSnapshot({ status: "open", stale: false });
      resetStaleWatchdog();
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
      if (TRANSIENT_SOURCE_REASONS.has(diagnostic.reason)) scheduleReconnect();
    });

    next.addEventListener("log_end", () => {
      if (es !== next) return;
      stopConnection();
      scheduleReconnect();
    });

    next.addEventListener("error", () => {
      if (es !== next) return;
      if (next.readyState === READY_STATE_CLOSED) {
        setSnapshot({ status: "closed" });
      } else {
        setSnapshot({ status: "reconnecting" });
        if (document.visibilityState === "hidden") pauseConnecting();
      }
    });
    if (document.visibilityState === "hidden") pauseConnecting();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
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
      clearReconnectTimer();
      reconnectPending = false;
      reconnectStep = 0;
      stopConnection();
      setSnapshot({ status: "connecting", stale: false, error: undefined });
      open();
    },
    close() {
      closed = true;
      clearReconnectTimer();
      reconnectPending = false;
      stopConnection();
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
