// Checkpoint R5-Upstreams, the automatable half: §23.5's composition and the
// page's own §27.4 completeness equation over the production-size payload.

import { describe, expect, it } from "vitest";
import { en, ru } from "../../../i18n";
import { describeField, lookupField } from "../fieldCatalog";
import { upstreams, upstreamQuality } from "../__fixtures__";
import { upstreamsPagePayload } from "../../diag/upstreams.helpers";
import { classifyValue, resolveSections } from "../resolveSections";
import type { CollectionSectionInstance, ScalarSectionInstance } from "../resolveSections";
import { buildRecordNodes } from "../renderers/unknownFields";
import {
  UPSTREAMS_FILTER_UNHEALTHY,
  UPSTREAMS_ZERO_FIELDS,
  bestLatencyMs,
  connectSuccessPct,
  unhealthyUpstreams,
  upstreamKey,
  upstreamStatusLine,
  upstreamsPageDefinition,
  type UpstreamsPagePayload,
} from "./upstreams";

const full = upstreamsPagePayload(upstreams, upstreamQuality) as UpstreamsPagePayload;

function resolveFor(context: UpstreamsPagePayload) {
  return resolveSections({ definition: upstreamsPageDefinition, context });
}

function sectionById(context: UpstreamsPagePayload, id: string) {
  const section = resolveFor(context).sections.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no section ${id}`);
  return section;
}

describe("Upstreams page definition (spec §23.5)", () => {
  it("renders ONE entity list keyed by upstream_id, not two groups per upstream", () => {
    const list = sectionById(full, "upstreams") as CollectionSectionInstance;
    expect(list.kind).toBe("entityList");
    expect(list.items).toHaveLength(1);
    expect(list.itemKeys).toEqual(["u0"]);
    expect(upstreamKey({ upstream_id: 7 })).toBe("u7");
    // The old page's second heading — «Качество апстрима #0» — has no
    // section of its own any more; the merge happened in the adapter.
    const ids = resolveFor(full).sections.map((s) => s.id);
    expect(ids.filter((id) => id.includes("upstream"))).toEqual(["upstreams"]);
  });

  it("gives the nested dc[] a block of its own inside the surface (§10.4)", () => {
    const list = sectionById(full, "upstreams") as CollectionSectionInstance;
    // The surface renders the record through buildRecordNodes; `dc` MUST
    // come back as an array node with its five records, never as a row and
    // never comma-joined.
    const nodes = buildRecordNodes(list.items[0], "upstreams[0]");
    const dc = nodes.find((node) => node.key === "dc");
    expect(dc?.kind).toBe("array");
    if (dc?.kind !== "array") return;
    expect(dc.primitives).toBe(false);
    expect(dc.items).toHaveLength(5);
    expect(dc.presence).toBe("present");
  });

  it("keeps the compact row's two highlights described rather than guessed", () => {
    // EntityListSection resolves a highlight against `<collection>.<field>`,
    // so without the catalog aliases these two would fall to the counters
    // family and print an unlabelled number.
    expect(lookupField("upstreams.effective_latency_ms").source).toBe("exact");
    expect(describeField("upstreams.effective_latency_ms", ru).unit).toBe("milliseconds");
    expect(lookupField("upstreams.fails").source).toBe("exact");
  });

  it("names the row with Telemt's own words for what the route is", () => {
    expect(
      upstreamStatusLine({ ...upstreams.upstreams![0], healthy: false }),
    ).toBe("direct · direct · unhealthy");
  });

  it("places every zero counter, in four named blocks", () => {
    const placed = ["connect_totals", "connect_attempts", "connect_duration_success", "connect_duration_fail"]
      .flatMap((id) => (sectionById(full, id) as ScalarSectionInstance).rows.map((r) => r.path));
    expect(placed).toEqual(UPSTREAMS_ZERO_FIELDS.map((name) => `zero.${name}`));
    expect(placed).toHaveLength(16);
  });

  it("offers the one domain-relevant filter, and a tile that aims at it (§18.2)", () => {
    const list = upstreamsPageDefinition.sections.find((s) => s.id === "upstreams");
    expect(list?.kind).toBe("entityList");
    if (list?.kind !== "entityList") return;
    expect(list.filters?.map((f) => f.key)).toEqual([UPSTREAMS_FILTER_UNHEALTHY]);
    const tile = (upstreamsPageDefinition.summary ?? []).find((m) => m.id === "healthy");
    expect(tile?.shortcut?.filter).toEqual({ key: UPSTREAMS_FILTER_UNHEALTHY, value: true });
    // …and the predicate really selects the unhealthy ones.
    const unhealthy = { ...upstreams.upstreams![0], healthy: false };
    expect(list.filters?.[0].predicate(unhealthy, true)).toBe(true);
    expect(list.filters?.[0].predicate(upstreams.upstreams![0], true)).toBe(false);
  });

  it("computes the tiles from the data, and shows «—» where there is no answer", () => {
    expect(unhealthyUpstreams(upstreams.upstreams)).toBe(0);
    expect(unhealthyUpstreams(undefined)).toBeNull();
    expect(bestLatencyMs(upstreams.upstreams)).toBe(41);
    expect(bestLatencyMs([{ ...upstreams.upstreams![0], effective_latency_ms: null }])).toBeNull();
    expect(connectSuccessPct(upstreams.zero)).toBeCloseTo(99.69, 2);
    // A rate over zero attempts is unknown, not 100 % (§13.1).
    expect(connectSuccessPct({ connect_attempt_total: 0, connect_success_total: 0 })).toBeNull();
    expect(connectSuccessPct(undefined)).toBeNull();
  });

  it("reads the merged upstream as a stable record, never as a counters map", () => {
    // The catalog describes every leaf, so criterion (c) of the dynamic-map
    // test fails and the record keeps named fields (Task 2 carry-over).
    expect(classifyValue(full.upstreams?.[0], { path: "upstreams[0]" })).toBe("object");
    expect(classifyValue(full.summary, { path: "summary" })).toBe("object");
    expect(classifyValue(full.zero, { path: "zero" })).toBe("object");
  });

  it("gives each response envelope its own block, under its own source", () => {
    // The two envelopes come from two different topics — `upstreams` and
    // `runtime` — so they are two sections: one `sourceId` for both made the
    // quality rows read «не пришло в ответе» under a header claiming a
    // healthy source whenever `runtime` was still loading.
    const metadata = sectionById(full, "metadata") as ScalarSectionInstance;
    const quality = sectionById(full, "metadata_quality") as ScalarSectionInstance;
    expect(metadata.sourceId).toBe("upstreams");
    expect(quality.sourceId).toBe("quality");

    // Without an override every row names itself by the last path segment,
    // so the two blocks together would draw `enabled` / `reason` /
    // `generated_at_epoch_secs` twice over and leave the sentence
    // underneath as the only clue which endpoint answered.
    const labels = [...metadata.rows, ...quality.rows].map(
      (r) => describeField(r.path, ru).label,
    );
    expect(labels).toEqual([
      "stats.enabled",
      "stats.reason",
      "stats.generated_at_epoch_secs",
      "upstream_quality.enabled",
      "upstream_quality.reason",
      "upstream_quality.generated_at_epoch_secs",
    ]);
    // Telemt's own spelling, so the row reads identically in both locales
    // (§8.1) — only the sentence under it is translated.
    expect(
      [...metadata.rows, ...quality.rows].map((r) => describeField(r.path, en).label),
    ).toEqual(labels);
    // The invariant behind the strings above: no two rows of this block may
    // offer the reader the same name.
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("checkpoint R5-Upstreams: completeness (§27.4, ruling R7)", () => {
  it("accounts for every leaf of the production payload", () => {
    const result = resolveFor(full);
    // 1 upstream x (9 fields + 5 dc rows x 3) + 7 route totals + 16 zero
    // counters + 5 policy knobs + 2 x 3 envelope fields.
    expect(result.allPaths.length).toBe(56);
    expect(result.lostPaths).toEqual([]);
    expect(
      result.unknownPaths,
      `unplaced upstream paths:\n${result.unknownPaths.join("\n")}`,
    ).toEqual([]);
    expect(result.ignoredPaths).toEqual([]);
    expect(result.extractedFromScalars).toEqual([]);
  });

  it("hands a field we have never seen to the tail instead of swallowing it", () => {
    // No section on this page is anchored on the whole payload, so a block
    // a future Telemt adds MUST surface in R2's extended tail rather than
    // disappear into somebody's claim.
    const future = {
      ...full,
      a_block_from_a_future_telemt: { some_total: 1 },
    } as unknown as UpstreamsPagePayload;
    const result = resolveFor(future);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual(["a_block_from_a_future_telemt.some_total"]);
    expect(result.consumedPaths).not.toContain("a_block_from_a_future_telemt.some_total");
  });

  it("hands a field nested inside a bound record to the tail too", () => {
    // A top-level block is the weakest probe available. A key added INSIDE
    // a record a scalars section already reads is where a field disappears
    // if a section is allowed to claim a subtree it only partly renders.
    const future = {
      ...full,
      upstream_quality: {
        ...full.upstream_quality,
        policy: { ...full.upstream_quality?.policy, future_knob_ms: 250 },
      },
    } as unknown as UpstreamsPagePayload;
    const result = resolveFor(future);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual(["upstream_quality.policy.future_knob_ms"]);
    expect(result.consumedPaths).not.toContain("upstream_quality.policy.future_knob_ms");
  });

  it("draws a future field on an upstream itself rather than tailing it", () => {
    // The counterpart of the two probes above: the entity list renders
    // EVERY key of an item through `buildRecordNodes`, so owning the
    // subtree is honest here — the field is on screen, not in the tail.
    const richer = {
      ...full,
      upstreams: [{ ...full.upstreams![0], future_field: 7 }],
    } as unknown as UpstreamsPagePayload;
    const result = resolveFor(richer);
    expect(result.unknownPaths).toEqual([]);
    expect(result.consumedPaths).toContain("upstreams[0].future_field");
  });

  it("stays complete with only one of the two endpoints answering", () => {
    for (const context of [
      upstreamsPagePayload(upstreams, null) as UpstreamsPagePayload,
      upstreamsPagePayload(null, upstreamQuality) as UpstreamsPagePayload,
    ]) {
      const result = resolveFor(context);
      expect(result.lostPaths).toEqual([]);
      expect(result.unknownPaths).toEqual([]);
    }
  });
});
