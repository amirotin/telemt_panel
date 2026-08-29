import type { RuntimeEdgeEvents } from "../../realtime/topics";
import type { EventsPagePayload } from "../details-builder/definitions/events";

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
