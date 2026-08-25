import { withBasePath } from "../lib/base-path";
import { getSnapshot } from "../lib/api/generated/sdk.gen";
import type { ConnectionSnapshot, TopicName, TopicSnapshot } from "./types";

// Defaults per Task 4's brief (02-hub-sse.md protocol + the M3 frontend
// plan's SSE-client deliverable):
const DEFAULT_DEBOUNCE_MS = 150; // coalesce subscribe/unsubscribe churn from navigation
const DEFAULT_STALE_MS = 40_000; // no frame (event or heartbeat) for 40s => global stale
const DEFAULT_FAILURE_THRESHOLD = 3; // >3 consecutive onerror => fall back to polling
const DEFAULT_POLL_INTERVAL_MS = 10_000;

// READY_STATE_CLOSED mirrors the standard EventSource.CLOSED value (2).
// Used instead of referencing the global `EventSource` constant directly so
// this module (and its tests, which supply a fake) never depends on a real
// EventSource implementation existing in the current environment.
const READY_STATE_CLOSED = 2;

const EMPTY_TOPIC_SNAPSHOT: TopicSnapshot = { data: null, ts: null, stale: false, error: null };

type SnapshotFetcher = (
  topics: TopicName[],
) => Promise<Record<string, { v: unknown; ts: number } | undefined>>;

export interface SSEClientOptions {
  /** Test seam: defaults to `new EventSource(url, {withCredentials: true})`. */
  eventSourceFactory?: (url: string) => EventSource;
  /** Test seam for the >3-failures fallback poll: defaults to GET /api/snapshot. */
  fetchSnapshot?: SnapshotFetcher;
  debounceMs?: number;
  staleMs?: number;
  pollIntervalMs?: number;
  failureThreshold?: number;
}

export interface SSEClient {
  /** Ref-counts this topic; returns the unsubscribe function. */
  subscribeTopic(topic: TopicName): () => void;
  getTopicSnapshot<T = unknown>(topic: TopicName): TopicSnapshot<T>;
  subscribeTopicListener(topic: TopicName, cb: () => void): () => void;
  getConnectionSnapshot(): ConnectionSnapshot;
  subscribeConnectionListener(cb: () => void): () => void;
  /** Manual "reconnect now" action for a visible reconnecting/polling state. */
  retry(): void;
  /**
   * Fetches `topic` via GET /api/snapshot right now and installs the
   * result into the snapshot store (notifying subscribers) — a manual
   * "refresh this one topic" action, independent of the topic's own poll
   * interval or the >3-failures polling fallback. Resolves once the fetch
   * attempt settles (success or failure — errors are swallowed, matching
   * the fallback poller's own silent-retry behavior); callers needn't
   * await it.
   */
  refreshTopic(topic: TopicName): Promise<void>;
  /** Clears all cached data/state (logout) — see useLogout. */
  reset(): void;
  /** Test/teardown only. */
  dispose(): void;
}

// createSSEClient builds one multiplexed SSE connection: every mounted
// useTopic()/useSnapshot() subscriber ref-counts a topic, and the client
// maintains exactly one EventSource whose `topics=` query is the union of
// currently-subscribed topics (02-hub-sse.md principle 1 — one poll per
// topic no matter how many browser tabs/components want it — mirrored
// client-side as one connection no matter how many components want it).
// Rebuilds are debounced so navigating between screens (which usually
// unsubscribes one topic and subscribes another in the same tick) doesn't
// thrash the connection.
export function createSSEClient(options: SSEClientOptions = {}): SSEClient {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const eventSourceFactory =
    options.eventSourceFactory ?? ((url: string) => new EventSource(url, { withCredentials: true }));
  const fetchSnapshotFn = options.fetchSnapshot ?? defaultFetchSnapshot;

  const refCounts = new Map<TopicName, number>();
  const snapshots = new Map<TopicName, TopicSnapshot>();
  const topicListeners = new Map<TopicName, Set<() => void>>();
  const connectionListeners = new Set<() => void>();

  let es: EventSource | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let consecutiveFailures = 0;
  let connection: ConnectionSnapshot = { status: "closed", stale: false };
  let disposed = false;
  // generation increments on reset()/dispose(); an in-flight snapshot fetch
  // that started under an older generation must not install into the store
  // or re-arm the stale watchdog after teardown.
  let generation = 0;
  // lastTopicsKey lets a rebuild triggered by a ref-count-only change (same
  // topic set, e.g. a second subscriber of an already-subscribed topic
  // mounting/unmounting) skip tearing down a live or already-reconnecting
  // EventSource — avoids losing the browser's own Last-Event-ID replay
  // state for no reason.
  let lastTopicsKey: string | null = null;

  function notifyTopic(topic: TopicName) {
    const set = topicListeners.get(topic);
    if (!set) return;
    for (const cb of set) cb();
  }

  function notifyConnection() {
    for (const cb of connectionListeners) cb();
  }

  function setConnection(patch: Partial<ConnectionSnapshot>) {
    const next: ConnectionSnapshot = { ...connection, ...patch };
    if (next.status === connection.status && next.stale === connection.stale) return;
    connection = next;
    notifyConnection();
  }

  function activeTopics(): TopicName[] {
    const out: TopicName[] = [];
    for (const [topic, count] of refCounts) {
      if (count > 0) out.push(topic);
    }
    return out.sort();
  }

  function resetStaleWatchdog() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      setConnection({ stale: true });
    }, staleMs);
  }

  // onFrame runs for every SSE frame — a topic event, a heartbeat, a
  // source_error, or (while the polling fallback is active) a successful
  // poll response: anything that proves the connection is currently alive
  // and current, which is exactly what the 40s global-stale watchdog
  // tracks (02-hub-sse.md's heartbeat note: "клиент не может по нему
  // определить, жив ли поток" is why heartbeat is an observable frame at
  // all, not just an SSE comment).
  function onFrame() {
    resetStaleWatchdog();
    setConnection({ stale: false });
  }

  function applyTopicData(topic: TopicName, data: unknown, ts: number) {
    snapshots.set(topic, { data, ts, stale: false, error: null });
    notifyTopic(topic);
  }

  function applyTopicError(topic: TopicName, code: string) {
    const prev = snapshots.get(topic) ?? EMPTY_TOPIC_SNAPSHOT;
    snapshots.set(topic, { ...prev, stale: true, error: code });
    notifyTopic(topic);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPollingIfNeeded() {
    if (pollTimer) return;
    setConnection({ status: "polling" });
    pollTimer = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
    void pollOnce();
  }

  // fetchAndInstall is the one GET /api/snapshot fetch-and-install
  // implementation: the >3-failures polling fallback (pollOnce) and the
  // manual refreshTopic() (fix round 1: called after every user mutation
  // so a create/edit/delete doesn't wait out the topic's own poll interval
  // to show up) both go through this, rather than each having its own copy.
  async function fetchAndInstall(topics: TopicName[]) {
    if (topics.length === 0 || disposed) return;
    const gen = generation;
    try {
      const result = await fetchSnapshotFn(topics);
      if (disposed || gen !== generation) return;
      for (const topic of topics) {
        const entry = result[topic];
        if (!entry) continue;
        applyTopicData(topic, entry.v, entry.ts);
      }
      onFrame();
    } catch {
      // Silent — the next poll tick (pollOnce) or the caller's own retry
      // (refreshTopic) tries again; the browser's own SSE reconnect
      // attempts keep racing in parallel regardless.
    }
  }

  async function pollOnce() {
    await fetchAndInstall(activeTopics());
  }

  function markConnected() {
    consecutiveFailures = 0;
    stopPolling();
    setConnection({ status: "open" });
  }

  function closeEventSource() {
    if (es) {
      es.close();
      es = null;
    }
  }

  function scheduleRebuild() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      rebuildNow();
    }, debounceMs);
  }

  function rebuildNow(force = false) {
    if (disposed) return;
    if (backoffTimer) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
    const topics = activeTopics();
    const topicsKey = topics.join(",");

    if (topics.length === 0) {
      closeEventSource();
      lastTopicsKey = null;
      stopPolling();
      if (staleTimer) {
        clearTimeout(staleTimer);
        staleTimer = null;
      }
      setConnection({ status: "closed", stale: false });
      return;
    }

    if (!force && topicsKey === lastTopicsKey && es) {
      // Same topic set, connection still alive or already reconnecting on
      // its own — nothing to rebuild.
      return;
    }

    closeEventSource();
    lastTopicsKey = topicsKey;
    // Starting a new SSE attempt must not visually downgrade an active
    // polling fallback back to "connecting" — polling only ends via
    // markConnected() (a real SSE success), never merely by attempting one.
    if (connection.status !== "polling") {
      setConnection({ status: connection.status === "open" ? "reconnecting" : "connecting" });
    }
    const url = withBasePath("/api/events") + "?topics=" + topicsKey;
    const next = eventSourceFactory(url);
    es = next;

    next.addEventListener("open", () => {
      if (es !== next) return;
      markConnected();
      onFrame();
    });

    next.addEventListener("heartbeat", () => {
      if (es !== next) return;
      onFrame();
    });

    next.addEventListener("source_error", (ev) => {
      if (es !== next) return;
      onFrame();
      const parsed = parseJSON<{ topic?: string; code?: string }>((ev as MessageEvent).data);
      if (parsed?.topic && parsed.code) {
        applyTopicError(parsed.topic as TopicName, parsed.code);
      }
    });

    for (const topic of topics) {
      next.addEventListener(topic, (ev) => {
        if (es !== next) return;
        const parsed = parseJSON<{ v: unknown; ts: number }>((ev as MessageEvent).data);
        if (!parsed) return;
        markConnected();
        applyTopicData(topic, parsed.v, parsed.ts);
        onFrame();
      });
    }

    next.addEventListener("error", () => {
      if (es !== next) return;
      consecutiveFailures += 1;
      if (connection.status !== "polling") {
        setConnection({ status: "reconnecting" });
      }
      if (next.readyState === READY_STATE_CLOSED) {
        // The browser gave up and will not retry on its own (e.g. the
        // response wasn't 200 text/event-stream at all — an expired
        // session, a proxy error page). es is genuinely dead now — clear it
        // (without calling close() again) so rebuildNow's same-topic-set
        // skip doesn't mistake it for a still-live connection — and
        // schedule our own backoff.
        if (es === next) es = null;
        if (consecutiveFailures === 1) {
          // First failure of this streak: probe once via the plain GET
          // /api/snapshot fetch path (same one refreshTopic/the polling
          // fallback use) so an expired session (401) reaches the SDK
          // client's response interceptor — and its /login redirect —
          // within about a second, instead of only after the 4th backoff
          // attempt (~14s). Reuses pollOnce/fetchAndInstall exactly as-is:
          // it already swallows its own errors and never touches
          // consecutiveFailures or startPollingIfNeeded, so this probe
          // cannot itself double-count as a failure or start the polling
          // loop. A transient network error here is silently discarded —
          // the backoff scheduled below keeps retrying regardless.
          void pollOnce();
        }
        const delay = Math.min(1000 * 2 ** consecutiveFailures, 30_000);
        backoffTimer = setTimeout(rebuildNow, delay);
      }
      // Otherwise readyState is CONNECTING: the browser's own EventSource
      // reconnect is already in flight, nothing more to schedule here.
      if (consecutiveFailures > failureThreshold) {
        startPollingIfNeeded();
      }
    });
  }

  return {
    subscribeTopic(topic) {
      refCounts.set(topic, (refCounts.get(topic) ?? 0) + 1);
      if (!snapshots.has(topic)) snapshots.set(topic, EMPTY_TOPIC_SNAPSHOT);
      scheduleRebuild();
      return () => {
        const count = (refCounts.get(topic) ?? 1) - 1;
        if (count <= 0) {
          refCounts.delete(topic);
        } else {
          refCounts.set(topic, count);
        }
        scheduleRebuild();
      };
    },
    getTopicSnapshot<T = unknown>(topic: TopicName) {
      return (snapshots.get(topic) ?? EMPTY_TOPIC_SNAPSHOT) as TopicSnapshot<T>;
    },
    subscribeTopicListener(topic, cb) {
      let set = topicListeners.get(topic);
      if (!set) {
        set = new Set();
        topicListeners.set(topic, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    getConnectionSnapshot() {
      return connection;
    },
    subscribeConnectionListener(cb) {
      connectionListeners.add(cb);
      return () => connectionListeners.delete(cb);
    },
    retry() {
      consecutiveFailures = 0;
      rebuildNow(true);
    },
    refreshTopic(topic) {
      return fetchAndInstall([topic]);
    },
    reset() {
      generation++;
      closeEventSource();
      stopPolling();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (backoffTimer) clearTimeout(backoffTimer);
      if (staleTimer) clearTimeout(staleTimer);
      debounceTimer = null;
      backoffTimer = null;
      staleTimer = null;
      consecutiveFailures = 0;
      lastTopicsKey = null;
      snapshots.clear();
      connection = { status: "closed", stale: false };
      notifyConnection();
      if (activeTopics().length > 0) scheduleRebuild();
    },
    dispose() {
      disposed = true;
      generation++;
      closeEventSource();
      stopPolling();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (backoffTimer) clearTimeout(backoffTimer);
      if (staleTimer) clearTimeout(staleTimer);
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

// defaultFetchSnapshot is the real (non-test) fallback poller: GET
// /api/snapshot returns `{[topic]: <topic's raw payload>}` directly (no
// {v,ts} wrapper, unlike SSE frames — api/openapi.yaml getSnapshot), so a
// synthetic "now" timestamp stands in for the frame's own `ts`.
async function defaultFetchSnapshot(
  topics: TopicName[],
): Promise<Record<string, { v: unknown; ts: number } | undefined>> {
  const { data } = await getSnapshot({ query: { topics: topics.join(",") }, throwOnError: true });
  const out: Record<string, { v: unknown; ts: number } | undefined> = {};
  const nowSecs = Math.floor(Date.now() / 1000);
  for (const topic of topics) {
    const raw: unknown = (data as Record<string, unknown>)[topic];
    if (raw && typeof raw === "object") {
      out[topic] = { v: raw, ts: nowSecs };
    }
  }
  return out;
}
