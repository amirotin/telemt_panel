import { useMemo, useSyncExternalStore } from "react";
import { useSSEClient, useTopic } from "./context";
import type { SSEClient } from "./sseClient";
import type { TopicName } from "./types";

// A tab-local sliding window over a topic's recent snapshots.
//
// Telemt's stats/summary exposes only CUMULATIVE counters
// (connections_bad_total, handshake_timeouts_total,
// handshake_failures_by_class): on a 20-day-old server they carry 20 days of
// background scanner noise and stay non-zero forever, so ranking them as
// "current problems" makes a healthy proxy permanently look broken. The hub
// records history for connections/active_users/traffic only, and adding a
// counter-history backend is out of scope here — so the client keeps its own
// short ring of timestamped snapshots and reads the delta across it.
//
// The ring is per-hook-instance (plain component state) and therefore per
// tab and per mount: it starts empty on every page open, which is exactly
// the honest behaviour the rate rules want — no window, no delta, no alarm.

export interface WindowEntry<T> {
  ts: number;
  data: T;
}

export interface TopicWindow<T> {
  /** Oldest snapshot still inside the window — null until a second one lands. */
  oldest: WindowEntry<T> | null;
  /** Most recent snapshot; null before the topic has produced any data. */
  newest: WindowEntry<T> | null;
  /** How many snapshots the window currently holds (0, 1 or more). */
  size: number;
}

// Hard cap on retained entries, independent of windowMs. The stats topic
// polls every few seconds, so 15 minutes is a couple hundred entries at
// most; the cap only guards against a pathological poll cadence turning the
// ring into an unbounded leak.
const MAX_ENTRIES = 256;

// pushWindowEntry appends one snapshot and evicts everything older than
// `windowMs` before `entry.ts`. Returns the SAME array reference when the
// entry is a duplicate (identical ts to the current newest), so a re-render
// or a StrictMode double-effect cannot grow the ring or trigger a render
// loop. Entries are kept in arrival order, oldest first.
export function pushWindowEntry<T>(
  entries: readonly WindowEntry<T>[],
  entry: WindowEntry<T>,
  windowMs: number,
): WindowEntry<T>[] {
  const last = entries[entries.length - 1];
  if (last && last.ts === entry.ts) return entries as WindowEntry<T>[];
  const cutoff = entry.ts - windowMs;
  const kept = entries.filter((e) => e.ts >= cutoff);
  kept.push(entry);
  return kept.length > MAX_ENTRIES ? kept.slice(kept.length - MAX_ENTRIES) : kept;
}

// readWindow reduces the ring to the only two entries any rate rule needs.
// `oldest` stays null for a single-entry ring: one snapshot is not a window,
// and a caller that treated oldest === newest as a zero delta would report
// "nothing changed" when the truth is "nothing is known yet".
export function readWindow<T>(entries: readonly WindowEntry<T>[]): TopicWindow<T> {
  if (entries.length === 0) return { oldest: null, newest: null, size: 0 };
  const newest = entries[entries.length - 1];
  return {
    oldest: entries.length < 2 ? null : entries[0],
    newest,
    size: entries.length,
  };
}

const EMPTY: TopicWindow<never> = { oldest: null, newest: null, size: 0 };

// createTopicWindowStore is a useSyncExternalStore-shaped view over the SSE
// client: it listens to one topic, records each distinct snapshot into the
// ring, and republishes the reduced oldest/newest view. Keeping the ring in
// the store (not in React state) is what lets the hook stay a pure
// subscription — the same reason context.tsx's useSnapshot reads the client
// through useSyncExternalStore instead of mirroring it into state.
function createTopicWindowStore<T>(client: SSEClient, topic: TopicName, windowMs: number) {
  let entries: WindowEntry<T>[] = [];
  let view: TopicWindow<T> = EMPTY;
  const listeners = new Set<() => void>();

  const record = () => {
    const snapshot = client.getTopicSnapshot<T>(topic);
    if (snapshot.ts === null || snapshot.data === null) return;
    const next = pushWindowEntry(entries, { ts: snapshot.ts, data: snapshot.data }, windowMs);
    // Same reference means the frame carried no new timestamp — nothing to
    // republish, and no re-render for every heartbeat.
    if (next === entries) return;
    entries = next;
    view = readWindow(entries);
    for (const listener of listeners) listener();
  };

  return {
    subscribe(onStoreChange: () => void): () => void {
      listeners.add(onStoreChange);
      const unlisten = client.subscribeTopicListener(topic, record);
      // Seed from whatever the client already has cached, so a remount does
      // not silently drop the current snapshot from the window.
      record();
      return () => {
        listeners.delete(onStoreChange);
        unlisten();
      };
    },
    getSnapshot(): TopicWindow<T> {
      return view;
    },
  };
}

// useTopicWindow subscribes to `topic` like useSnapshot does and additionally
// remembers its recent snapshots for `windowMs`, handing back the oldest and
// newest of them. Callers diff the two to turn a cumulative counter into a
// per-window rate (see pulse/widgets/problems.helpers.ts).
export function useTopicWindow<T = unknown>(topic: TopicName, windowMs: number): TopicWindow<T> {
  const client = useSSEClient();
  useTopic(topic);
  const store = useMemo(
    () => createTopicWindowStore<T>(client, topic, windowMs),
    [client, topic, windowMs],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
