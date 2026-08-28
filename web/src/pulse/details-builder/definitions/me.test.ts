// Checkpoint R5-ME, the automatable half: the ME page's own §27.4
// completeness equation on the production-size fixtures, plus the §23.2
// composition it is judged against.
//
//   all normalized paths − consumed − explicitly ignored = unknown tail
//
// and for a MIGRATED domain the tail must be EMPTY in every source
// combination — including the ones where a gate is off, which is exactly
// when the old page silently dropped a group.

import { describe, expect, it } from "vitest";
import { ru } from "../../../i18n";
import { describeField } from "../fieldCatalog";
import { mePagePayload } from "../../diag/me.helpers";
import {
  gates,
  initialization,
  degradedWriterCount,
  mePoolState,
  meQuality,
  meRuntime,
  meRuntimeFieldCount,
  meSelftest,
  meWriterVariants,
  meWriters,
  selftestAllNullable,
  writerCount,
} from "../__fixtures__";
import { resolveSections } from "../resolveSections";
import type {
  CollectionSectionInstance,
  ScalarSectionInstance,
} from "../resolveSections";
import {
  boundClientsTotal,
  degradedWriters,
  meDcGroupKey,
  meDcGroupOrder,
  meDcLabel,
  mePageDefinition,
  meWriterKey,
  rttP95,
  writerStatusLine,
  writersByDc,
  ME_FILTER_DEGRADED,
  ME_RUNTIME_FIELDS,
} from "./me";
import type { MePagePayload } from "./me";

const full = mePagePayload({
  meWriters,
  gates,
  initialization,
  pool: mePoolState,
  quality: meQuality,
  selftest: meSelftest,
  meRuntime,
}) as MePagePayload;

function resolveFor(context: MePagePayload) {
  return resolveSections({ definition: mePageDefinition, context });
}

function sectionById(context: MePagePayload, id: string) {
  const section = resolveFor(context).sections.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no section ${id}`);
  return section;
}

describe("ME page definition (spec §23.2)", () => {
  it("carries the five tabs the spec names, in order", () => {
    expect(mePageDefinition.navigation?.tabs?.map((tab) => tab.id)).toEqual([
      "overview",
      "writers",
      "quality",
      "initialization",
      "runtime",
    ]);
  });

  it("gives every section exactly one tab, and no tab an id nothing declares", () => {
    const declared = new Set(mePageDefinition.sections.map((section) => section.id));
    // The §24 tail is resolved, not declared — it still needs a home, or it
    // would be computed and never drawn.
    declared.add("unknown-fields");
    const claimed = (mePageDefinition.navigation?.tabs ?? []).flatMap((tab) => tab.sections ?? []);
    expect(new Set(claimed).size).toBe(claimed.length);
    for (const id of claimed) expect(declared.has(id), id).toBe(true);
    for (const id of declared) expect(claimed).toContain(id);
  });

  it("renders the 46 writers as ONE entity list keyed by writer_id", () => {
    const writers = sectionById(full, "writers") as CollectionSectionInstance;
    expect(writers.kind).toBe("entityList");
    expect(writers.items).toHaveLength(writerCount);
    expect(writers.itemKeys[0]).toBe(meWriterKey(meWriters.writers[0]));
    expect(new Set(writers.itemKeys).size).toBe(writerCount);
    // §10.5: 46 rows is over the search threshold, so the box is mandatory.
    expect(writers.searchRequired).toBe(true);
  });

  it("groups the writers by data center and filters by state (§23.2)", () => {
    const definition = mePageDefinition.sections.find((s) => s.id === "writers");
    if (definition?.kind !== "entityList") throw new Error("writers is not an entity list");
    expect(definition.groupBy).toBeDefined();
    const keys = meWriters.writers.map((w) => definition.groupBy?.key(w));
    // Twelve data centers, negative ids included — and the key is never
    // parsed back as a number, so `dc-1` and `dc1` stay different groups.
    expect(new Set(keys).size).toBe(12);
    expect(keys).toContain("dc-1");
    expect(definition.filters?.map((f) => f.key)).toEqual([
      "me.state",
      ME_FILTER_DEGRADED,
      "me.draining",
    ]);
    const degraded = definition.filters?.find((f) => f.key === ME_FILTER_DEGRADED);
    expect(meWriters.writers.filter((w) => degraded?.predicate(w, true)).length).toBe(
      degradedWriterCount,
    );
  });

  it("puts all sixteen writer fields in the surface, and only two on the row", () => {
    const definition = mePageDefinition.sections.find((s) => s.id === "writers");
    if (definition?.kind !== "entityList") throw new Error("writers is not an entity list");
    // §9.3: one to three headline values on the compact row; the surface is
    // where the rest lives, and it is built from the record itself.
    expect(definition.highlights).toEqual(["bound_clients", "rtt_ema_ms"]);
    expect(Object.keys(meWriters.writers[0])).toHaveLength(16);
  });

  it("names a writer's state from Telemt's own words, flags included", () => {
    const writer = meWriters.writers[0];
    expect(writerStatusLine({ ...writer, degraded: false, draining: false })).toBe("active");
    expect(writerStatusLine({ ...writer, degraded: true, draining: true })).toBe(
      "active · draining · degraded",
    );
  });

  it("orders the DC chips production-first, with unmapped writers last", () => {
    const ids = ["dc-203", "dc203", "dc-none", "dc1", "dc-1", "dc2"];
    expect([...ids].sort(meDcGroupOrder)).toEqual([
      "dc1",
      "dc2",
      "dc203",
      "dc-1",
      "dc-203",
      "dc-none",
    ]);
    expect(meDcGroupKey(null)).toBe("dc-none");
    expect(meDcLabel(null)).toBe("DC —");
    expect(meDcLabel(-203)).toBe("DC -203");
  });

  it("summarizes the pool with computed tiles, not with a single raw field", () => {
    const values = (mePageDefinition.summary ?? []).map((metric) => metric.value(full));
    const samples = meWriters.writers
      .map((w) => w.rtt_ema_ms)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    expect(values).toEqual([
      writerCount,
      degradedWriterCount,
      meWriters.writers.reduce((sum, w) => sum + w.bound_clients, 0),
      samples[Math.ceil(samples.length * 0.95) - 1],
    ]);
    // §18.2: the degraded tile aims the filter the Writers tab already has.
    const degraded = (mePageDefinition.summary ?? []).find((m) => m.id === "degraded");
    expect(degraded?.shortcut?.filter).toEqual({ key: ME_FILTER_DEGRADED, value: true });
  });

  it("leaves a tile at «—» rather than at zero when the writers never arrived", () => {
    // §13.1: "no source" is not "no writers". A confident 0 here would tell
    // an operator their pool is empty when the topic simply has not loaded.
    expect(degradedWriters(undefined)).toBeNull();
    expect(boundClientsTotal(undefined)).toBeNull();
    expect(rttP95(undefined)).toBeNull();
    // …and a pool where nothing was ever measured has no percentile at all.
    expect(rttP95(meWriters.writers.map((w) => ({ ...w, rtt_ema_ms: null })))).toBeNull();
  });

  it("distributes the writers across the data centers as breakdown pairs", () => {
    const rows = writersByDc(meWriters.writers);
    expect(rows).toHaveLength(12);
    expect(rows[0].class).toBe("DC 1");
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(writerCount);
    const distribution = sectionById(full, "distribution") as CollectionSectionInstance;
    expect(distribution.kind).toBe("breakdown");
    expect(distribution.items).toHaveLength(12);
  });

  it("renders the sixteen initialization components as ONE timeline (§23.2)", () => {
    const timeline = sectionById(full, "initialization_components") as CollectionSectionInstance;
    expect(timeline.kind).toBe("timeline");
    expect(timeline.items).toHaveLength(initialization.components.length);
    expect(timeline.itemKeys[0]).toBe(initialization.components[0].id);
  });

  it("draws the per-DC RTT chart without claiming the fields it does not draw", () => {
    const chart = mePageDefinition.sections.find((s) => s.id === "dc_rtt_chart");
    if (chart?.kind !== "custom") throw new Error("dc_rtt_chart is not a custom section");
    // Coverage/alive/required per DC are rendered by the array section next
    // to it; a chart that consumed the whole subtree would delete them from
    // the §27.4 accounting while drawing only one of the five fields.
    expect(chart.consumes).toEqual([]);
    expect(chart.select?.(full)).toHaveLength(meQuality.dc_rtt.length);
  });

  it("keeps every array in a block of its own, never in a scalar row", () => {
    const result = resolveFor(full);
    for (const id of [
      "dc_rtt",
      "family_states",
      "pool_draining",
      "pool_refill_by_dc",
      "quarantined_endpoints",
    ]) {
      expect(result.sections.find((s) => s.id === id)?.kind, id).toBe("array");
    }
    expect(result.extractedFromScalars).toEqual([]);
    const scalarPaths = result.sections
      .filter((s): s is ScalarSectionInstance => s.kind === "scalars")
      .flatMap((s) => s.rows.map((row) => row.path));
    expect(scalarPaths).not.toContain("writers");
    expect(scalarPaths).not.toContain("quality.dc_rtt");
  });

  it("places every one of the ~55 me_runtime knobs in a named group", () => {
    const placed = mePageDefinition.sections
      .filter((s) => s.kind === "scalars" && s.id.startsWith("me_runtime_"))
      .flatMap((s) => (s.kind === "scalars" ? s.fields.map((f) => f.path) : []));
    expect(placed).toEqual(ME_RUNTIME_FIELDS.map((name) => `me_runtime.${name}`));
    expect(new Set(placed).size).toBe(placed.length);
    // 54 scalar knobs plus `quarantined_endpoints`, which is an ArraySection.
    expect(placed.length + 1).toBe(meRuntimeFieldCount);
  });

  it("reads an in-array epoch as a moment, never as a duration (Task 3 carry-over)", () => {
    for (const path of [
      "writers[0].drain_started_at_epoch_secs",
      "writers[0].drain_deadline_epoch_secs",
      "quality.family_states[0].state_since_epoch_secs",
      "quality.drain_gate.updated_at_epoch_secs",
      "initialization.components[0].started_at_epoch_ms",
      "initialization.started_at_epoch_secs",
      "gates.reroute_to_direct_at_epoch_secs",
    ]) {
      expect(describeField(path, ru).unit, path).toBe("timestamp");
      expect(describeField(path, ru).description, path).not.toBe(ru.details.fields.families.seconds);
    }
  });
});

describe("checkpoint R5-ME: completeness (§27.4, ruling R7)", () => {
  const cases: Array<[string, MePagePayload]> = [
    ["every source on", full],
    [
      "runtime_edge and minimal both off",
      mePagePayload({ meWriters, gates, initialization }) as MePagePayload,
    ],
    [
      "minimal off",
      mePagePayload({
        meWriters,
        gates,
        initialization,
        pool: mePoolState,
        quality: meQuality,
        selftest: meSelftest,
      }) as MePagePayload,
    ],
    ["me-writers only", mePagePayload({ meWriters }) as MePagePayload],
    [
      "self-test with every nullable branch empty",
      mePagePayload({ meWriters, selftest: selftestAllNullable }) as MePagePayload,
    ],
    ["no writers at all", mePagePayload({ meWriters: meWriterVariants.absent }) as MePagePayload],
    ["an empty writers array", mePagePayload({ meWriters: meWriterVariants.empty }) as MePagePayload],
    ["a single writer", mePagePayload({ meWriters: meWriterVariants.one }) as MePagePayload],
  ];

  it.each(cases)("%s — the unknown tail is empty", (_name, context) => {
    const result = resolveFor(context);
    expect(result.lostPaths).toEqual([]);
    expect(
      result.unknownPaths,
      `undescribed/unplaced ME paths:\n${result.unknownPaths.join("\n")}`,
    ).toEqual([]);
    expect(result.ignoredPaths).toEqual([]);
    expect(result.consumedPaths.length).toBe(result.allPaths.length);
  });

  it("accounts for all 1 064 leaves of the full production payload", () => {
    // Pinned exactly, the way the DC and Security domains are: a bound
    // cannot tell a Telemt release that ADDED fields apart from one that
    // dropped them.
    expect(resolveFor(full).allPaths.length).toBe(1064);
  });

  it("keeps a nulled self-test branch out of the tail without pretending it rendered", () => {
    const context = mePagePayload({ selftest: selftestAllNullable }) as MePagePayload;
    const result = resolveFor(context);
    // `selftest.bnd` is null and `selftest.ip` is `{}` — both are LEAVES
    // (§10.3), owned by their sections through `alsoConsumes`.
    expect(result.consumedPaths).toContain("selftest.bnd");
    expect(result.consumedPaths).toContain("selftest.ip");
    expect(result.unknownPaths).toEqual([]);
  });
});
