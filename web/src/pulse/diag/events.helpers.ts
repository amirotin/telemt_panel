import type { RuntimeEdgeEventRecord, RuntimeEdgeEvents } from "../../realtime/topics";

export interface EventsPagePayload {
  events?: RuntimeEdgeEventRecord[];
  buffer?: { capacity: number; dropped_total: number };
}

export const EVENT_FAMILY_OTHER = "other";
export const EVENT_FAMILIES = ["admission", "config", "api"] as const;

export function eventFamily(eventType: string): string {
  const head = eventType.split(".")[0] ?? "";
  return EVENT_FAMILIES.includes(head as never) ? head : EVENT_FAMILY_OTHER;
}

export function orderedEvents(
  events: readonly RuntimeEdgeEventRecord[] | undefined,
): RuntimeEdgeEventRecord[] {
  return [...(events ?? [])].sort((a, b) => b.seq - a.seq);
}

export function eventTypeCount(events: readonly RuntimeEdgeEventRecord[] | undefined): number | null {
  if (events === undefined) return null;
  return new Set(events.map((event) => event.event_type)).size;
}

// eventsPagePayload nests the ring buffer's two numbers under `buffer`.
//
// The whole of the adapter, and the reason it exists at all: the field
// catalog's exact step is a GLOBAL namespace (spec §8.2), and `capacity`
// and `dropped_total` are also what the TLS capture report calls two of its
// own fields. Keeping the wire spelling here would let one domain's
// sentence describe the other's number whenever a lookup arrives without
// its endpoint scope. Everything else is passed through untouched.
export function eventsPagePayload(
  data: RuntimeEdgeEvents | null | undefined,
): EventsPagePayload | null {
  if (!data) return null;
  return {
    events: data.events,
    buffer: { capacity: data.capacity, dropped_total: data.dropped_total },
  };
}
