// Checkpoint R5-Events, the automatable half: §23.5's event feed and the
// §27.4 completeness equation over the 50 records every VPS returned
// (TELEMT_LIVE_API_DATA §18).

import { describe, expect, it } from "vitest";
import { ru } from "../../../i18n";
import { describeField, lookupField } from "../fieldCatalog";
import { admissionEventCount, eventCount, events } from "../__fixtures__";
import { eventsPagePayload } from "../../diag/events.helpers";
import type { RuntimeEdgeEventRecord } from "../../../realtime/topics";
import { classifyValue, resolveSections } from "../resolveSections";
import type { CollectionSectionInstance, ScalarSectionInstance } from "../resolveSections";
import type { EventsPagePayload } from "./events";
import {
  EVENTS_FILTER_FAMILY,
  EVENT_FAMILIES,
  EVENT_FAMILY_OTHER,
  eventFamily,
  eventKey,
  eventTypeCount,
  eventsPageDefinition,
  orderedEvents,
} from "./events";

const full = eventsPagePayload(events) as EventsPagePayload;

function resolveFor(context: EventsPagePayload) {
  return resolveSections({ definition: eventsPageDefinition, context });
}

function sectionById(context: EventsPagePayload, id: string) {
  const section = resolveFor(context).sections.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no section ${id}`);
  return section;
}

const listOf = (context: EventsPagePayload) =>
  sectionById(context, "events") as CollectionSectionInstance;

describe("Events page definition (spec §23.5)", () => {
  it("renders all fifty records, keyed by seq", () => {
    const list = listOf(full);
    expect(list.kind).toBe("entityList");
    expect(list.items).toHaveLength(eventCount);
    expect(eventKey({ seq: 90_012 })).toBe("e90012");
    expect(list.itemKeys.every((key) => key.startsWith("e"))).toBe(true);
    expect(new Set(list.itemKeys).size).toBe(eventCount);
  });

  it("puts the newest record first, whatever order Telemt sent", () => {
    // Telemt sends `events` ascending by seq, so reading the array as it
    // arrives would open the page on the OLDEST line.
    expect(events.events[0].seq).toBeLessThan(events.events[eventCount - 1].seq);
    const list = listOf(full);
    const seqs = list.items.map((item) => (item as RuntimeEdgeEventRecord).seq);
    expect(seqs[0]).toBe(events.events[eventCount - 1].seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    // …and the ordering never mutates the payload it was given.
    const copy = [...events.events];
    orderedEvents(events.events);
    expect(events.events).toEqual(copy);
  });

  it("shows only the first page of fifty and asks before revealing the rest (§10.5)", () => {
    const list = listOf(full);
    expect(list.paging.initial).toBe(20);
    expect(list.searchRequired).toBe(true);
  });

  it("filters by event family, with an `other` bucket for a Telemt we do not know", () => {
    const section = eventsPageDefinition.sections.find((s) => s.id === "events");
    if (section?.kind !== "entityList") throw new Error("entity list expected");
    const filter = section.filters?.[0];
    expect(filter?.key).toBe(EVENTS_FILTER_FAMILY);
    expect(filter?.options?.map((o) => o.value)).toEqual([
      ...EVENT_FAMILIES,
      EVENT_FAMILY_OTHER,
    ]);
    expect(eventFamily("admission.state")).toBe("admission");
    expect(eventFamily("api.user.create.ok")).toBe("api");
    expect(eventFamily("config.reload.applied")).toBe("config");
    // A family nobody has described yet stays REACHABLE rather than falling
    // out of every option.
    expect(eventFamily("quota.exhausted")).toBe(EVENT_FAMILY_OTHER);
    const admission = events.events.filter((e) => filter?.predicate(e, "admission"));
    expect(admission).toHaveLength(admissionEventCount);
  });

  it("names a row with the event type and explains it with the context (R6)", () => {
    const section = eventsPageDefinition.sections.find((s) => s.id === "events");
    if (section?.kind !== "entityList") throw new Error("entity list expected");
    const record = events.events[0];
    expect(section.identity(record)).toBe(record.event_type);
    expect(section.status?.(record)).toBe(record.context);
    expect(section.highlights).toEqual(["ts_epoch_secs"]);
  });

  it("prints the row's stamp as a time, not as a duration in seconds", () => {
    // EntityListSection resolves a highlight against `<collection>.<field>`;
    // without the catalog alias `events.ts_epoch_secs` the seconds FAMILY
    // would match `_secs` and render an epoch as «1 755 996 000 с».
    expect(lookupField("events.ts_epoch_secs").source).toBe("exact");
    expect(describeField("events.ts_epoch_secs", ru).unit).toBe("timestamp");
    expect(describeField("events.*.ts_epoch_secs", ru).unit).toBe("timestamp");
  });

  it("counts the tiles from the data and shows «—» where there is no answer", () => {
    expect(eventTypeCount(events.events)).toBe(3);
    expect(eventTypeCount(undefined)).toBeNull();
    const values = (eventsPageDefinition.summary ?? []).map((m) => m.value(full));
    expect(values[0]).toBe(eventCount);
    expect(values[1]).toBe(3);
    expect(values[2]).toBe(events.dropped_total);
    expect(values[3]).toBe(events.capacity);
  });

  it("gives the ring buffer's own numbers a block rather than a tile alone", () => {
    const buffer = sectionById(full, "buffer") as ScalarSectionInstance;
    expect(buffer.rows.map((r) => r.path)).toEqual(["buffer.capacity", "buffer.dropped_total"]);
  });

  it("reads one event as a stable record, never as a counters map", () => {
    expect(classifyValue(events.events[0], { path: "events[0]" })).toBe("object");
  });
});

describe("checkpoint R5-Events: completeness (§27.4, ruling R7)", () => {
  it("accounts for every leaf of the production payload", () => {
    const result = resolveFor(full);
    // 50 records x 4 fields + capacity + dropped_total.
    expect(result.allPaths.length).toBe(202);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths, `unplaced event paths:\n${result.unknownPaths.join("\n")}`).toEqual(
      [],
    );
    expect(result.ignoredPaths).toEqual([]);
    expect(result.extractedFromScalars).toEqual([]);
  });

  it("hands a field we have never seen to the tail instead of swallowing it", () => {
    const future = {
      ...full,
      a_block_from_a_future_telemt: { some_total: 1 },
    } as unknown as EventsPagePayload;
    const result = resolveFor(future);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual(["a_block_from_a_future_telemt.some_total"]);
    expect(result.consumedPaths).not.toContain("a_block_from_a_future_telemt.some_total");
  });

  it("hands a field nested inside the ring buffer to the tail too", () => {
    // A top-level block is the weakest probe available. A key added INSIDE
    // `buffer`, which a scalars section already reads field by field, is
    // where a field disappears if a section may claim a partial subtree.
    const future = {
      ...full,
      buffer: { ...full.buffer, future: { detail: 1 } },
    } as unknown as EventsPagePayload;
    const result = resolveFor(future);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual(["buffer.future.detail"]);
    expect(result.consumedPaths).not.toContain("buffer.future.detail");
  });

  it("draws a nested future field on an event record rather than tailing it", () => {
    // The counterpart: the entity list renders every key of a record
    // through `buildRecordNodes`, nested objects included, so owning the
    // `events` subtree keeps the field on screen instead of in the tail.
    const richer = {
      ...full,
      events: [{ ...full.events![0], future: { detail: "why" } }],
    } as unknown as EventsPagePayload;
    const result = resolveFor(richer);
    expect(result.unknownPaths).toEqual([]);
    expect(result.consumedPaths).toContain("events[0].future.detail");
  });

  it("stays complete on an empty buffer", () => {
    const empty = eventsPagePayload({ capacity: 200, dropped_total: 0, events: [] }) as EventsPagePayload;
    const result = resolveFor(empty);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual([]);
    expect(listOf(empty).presence).toBe("empty");
  });
});
