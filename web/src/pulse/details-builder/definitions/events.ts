// The Events Details page (spec §23.5: «Events: TimelineSection или event
// EntityListSection»), as a declarative definition.
//
// New in M4 task 8: the panel had a `recent_events` widget showing the last
// few lines and no page behind it at all. TELEMT_LIVE_API_DATA §18 records
// what the endpoint actually returns — exactly 50 records on every VPS,
// 48–49 of them `admission.state` — which is precisely the shape that needs
// a filter to be readable: without one, the two records a reader is looking
// for are buried under forty-eight repetitions of the same line.
//
// EntityListSection rather than TimelineSection, for that one reason: §9.5's
// timeline has no filter and no search, and a feed whose 50 rows are 96 %
// one event type is unreadable without them. The row still reads as a
// timeline entry — type, context, age — and the surface carries `seq` and
// the absolute stamp.
//
// The order is NEWEST FIRST. Telemt sends `events` ascending by `seq`, so
// reading the array as it arrives opens the page on the OLDEST record; the
// definition sorts, and `path` still owns the leaves so nothing changes
// about completeness accounting.
//
// R6 (sensitive data): `context` may carry operational detail — a username,
// an address — and it is shown to the admin verbatim, as everywhere else on
// these pages. No copy menu is attached.

import type { RuntimeEdgeEventRecord } from "../../../realtime/topics";
import type { DetailPageDefinition, SummaryTone } from "../model";

/**
 * The page context. `capacity` and `dropped_total` are nested under
 * `buffer` rather than left where the wire puts them: the field catalog's
 * exact step is GLOBAL, and both bare names already mean something else in
 * the TLS capture report. The adapter (diag/events.helpers.ts) does the
 * nesting; nothing else about the payload changes.
 */
export interface EventsPagePayload {
  events?: RuntimeEdgeEventRecord[];
  buffer?: { capacity: number; dropped_total: number };
}

export const EVENTS_PAGE_ID = "pulse.events";

const eventOf = (item: unknown) => item as RuntimeEdgeEventRecord;

/** Stable semantic key (§5.3): Telemt's own sequence number. */
export function eventKey(event: Pick<RuntimeEdgeEventRecord, "seq">): string {
  return `e${event.seq}`;
}

/**
 * The family an event type belongs to — the part before the first dot.
 *
 * The FILTER is built from families rather than from whole event types on
 * purpose. A page definition is static, so its filter options cannot be
 * derived from the payload (spec §7's model), and the whole types are
 * unbounded: `api.user.create.ok` is one of a family that grows with every
 * API verb Telemt adds. The four families below are the ones the live
 * snapshot carried, and anything else falls into `other` rather than
 * becoming unreachable — which is what keeps the control honest on a Telemt
 * newer than this catalog.
 */
export function eventFamily(eventType: string): string {
  const head = eventType.split(".")[0] ?? "";
  return EVENT_FAMILIES.includes(head as never) ? head : EVENT_FAMILY_OTHER;
}

export const EVENT_FAMILY_OTHER = "other";

/** Families observed on the three live VPS (TELEMT_LIVE_API_DATA §18). */
export const EVENT_FAMILIES = ["admission", "config", "api"] as const;

export const EVENTS_FILTER_FAMILY = "events.family";

/** Newest first. A copy: `select` must never reorder the payload in place. */
export function orderedEvents(
  events: readonly RuntimeEdgeEventRecord[] | undefined,
): RuntimeEdgeEventRecord[] {
  return [...(events ?? [])].sort((a, b) => b.seq - a.seq);
}

export function eventTypeCount(events: readonly RuntimeEdgeEventRecord[] | undefined): number | null {
  if (events === undefined) return null;
  return new Set(events.map((e) => e.event_type)).size;
}

function droppedTone(payload: EventsPagePayload): SummaryTone {
  const dropped = payload.buffer?.dropped_total;
  if (dropped === undefined) return "neutral";
  // A dropped event is one the panel will never see: the ring buffer
  // overflowed between two polls.
  return dropped > 0 ? "warn" : "good";
}

export const eventsPageDefinition: DetailPageDefinition<EventsPagePayload, EventsPagePayload> = {
  id: EVENTS_PAGE_ID,
  title: (s) => s.details.pages.events.title,
  description: (s) => s.details.pages.events.description,

  sources: [{ id: "events", topic: "runtime", required: true }],

  summary: [
    {
      id: "count",
      label: (s) => s.details.pages.events.countTile,
      value: (p) => p.events?.length ?? null,
      format: "integer",
    },
    {
      id: "types",
      label: (s) => s.details.pages.events.typesTile,
      value: (p) => eventTypeCount(p.events),
      format: "integer",
    },
    {
      id: "dropped_total",
      path: "buffer.dropped_total",
      value: (p) => p.buffer?.dropped_total ?? null,
      format: "integer",
      tone: droppedTone,
    },
    {
      id: "capacity",
      path: "buffer.capacity",
      value: (p) => p.buffer?.capacity ?? null,
      format: "integer",
    },
  ],

  sections: [
    {
      kind: "entityList",
      id: "events",
      // Telemt's own field name for the collection (§11.2).
      title: () => "events[]",
      description: (s) => s.details.pages.events.eventsDescription,
      sourceId: "events",
      path: "events",
      defaultExpanded: true,
      select: (p) => orderedEvents(p.events),
      itemKey: (item) => eventKey(eventOf(item)),
      // The TYPE names the row and the CONTEXT explains it — both are
      // Telemt's own strings, printed verbatim (§11.2).
      identity: (item) => eventOf(item).event_type,
      status: (item) => eventOf(item).context,
      highlights: ["ts_epoch_secs"],
      filters: [
        {
          key: EVENTS_FILTER_FAMILY,
          label: (s) => s.details.pages.events.filterFamily,
          options: [...EVENT_FAMILIES, EVENT_FAMILY_OTHER].map((family) => ({
            value: family,
            // The family IS the head of Telemt's own event type: verbatim.
            label: () => family,
          })),
          predicate: (item, value) => eventFamily(eventOf(item).event_type) === value,
        },
      ],
    },
    {
      kind: "scalars",
      id: "buffer",
      title: (s) => s.details.pages.events.buffer,
      description: (s) => s.details.pages.events.bufferDescription,
      sourceId: "events",
      fields: [{ path: "buffer.capacity" }, { path: "buffer.dropped_total" }],
    },
  ],

  unknownFields: { minMode: "extended", rawJson: true },
};
