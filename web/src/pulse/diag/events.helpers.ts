import type { RuntimeEdgeEventRecord } from "../../realtime/topics";

export const EVENT_FAMILY_OTHER = "other";
const EVENT_FAMILIES = ["admission", "config", "api"] as const;

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
