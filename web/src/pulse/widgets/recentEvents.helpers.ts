import type { RuntimeEdgeEventRecord, RuntimeEdgeEvents } from "../../realtime/topics";

export interface RecentEventsView {
  events: RuntimeEdgeEventRecord[];
  droppedTotal: number;
}

// computeRecentEventsView returns the newest events first (Telemt's own
// events/recent already lists them oldest-first per seq, matching a normal
// log — the compact feed widget wants most-recent-on-top). The SDK
// normalizes every decoded slice to non-nil (internal/telemt/normalize.go,
// mini-task 2c) before it ever reaches the hub, so `events` is always a
// real (possibly empty) array on the wire — no defensive `?? []` needed here.
export function computeRecentEventsView(payload: RuntimeEdgeEvents, limit = 10): RecentEventsView {
  return {
    events: [...payload.events].sort((a, b) => b.seq - a.seq).slice(0, limit),
    droppedTotal: payload.dropped_total,
  };
}
