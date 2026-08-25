import type { RuntimeEdgeEventRecord, RuntimeEdgeEvents } from "../../realtime/topics";

export interface RecentEventsView {
  events: RuntimeEdgeEventRecord[];
  droppedTotal: number;
}

// computeRecentEventsView returns the newest events first (Telemt's own
// events/recent already lists them oldest-first per seq, matching a normal
// log — the compact feed widget wants most-recent-on-top). `events` is a nil
// Go slice (no `omitempty`) when there's nothing recorded yet, which
// marshals as JSON `null`, not `[]` — confirmed against the live mock
// server — so this normalizes before sorting.
export function computeRecentEventsView(payload: RuntimeEdgeEvents, limit = 10): RecentEventsView {
  return {
    events: [...(payload.events ?? [])].sort((a, b) => b.seq - a.seq).slice(0, limit),
    droppedTotal: payload.dropped_total,
  };
}
