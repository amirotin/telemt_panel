// Checkpoint R5-Counters, the automatable half: §23.4's composition and the
// page's own §27.4 completeness equation over the production-size zero/all
// dump.

import { describe, expect, it } from "vitest";
import { ru } from "../../../i18n";
import { describeField, lookupField } from "../fieldCatalog";
import { zeroAll, zeroCoreScalarCount } from "../__fixtures__";
import type { ZeroAllData } from "../../../lib/api/generated/types.gen";
import { resolveSections } from "../resolveSections";
import type {
  CollectionSectionInstance,
  DynamicMapSectionInstance,
  ScalarSectionInstance,
} from "../resolveSections";
import {
  countersPageDefinition,
  counterLeaves,
  counterTotal,
  errorCounters,
  nonZeroCounters,
  COUNTER_GROUP_PATHS,
} from "./counters";

function resolveFor(context: ZeroAllData) {
  return resolveSections({ definition: countersPageDefinition, context });
}

function sectionById(context: ZeroAllData, id: string) {
  const section = resolveFor(context).sections.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no section ${id}`);
  return section;
}

describe("Counters page definition (spec §23.4)", () => {
  it("renders one DynamicMapSection group per zero/all section", () => {
    const map = sectionById(zeroAll, "all") as DynamicMapSectionInstance;
    expect(map.kind).toBe("dynamicMap");
    expect(map.groups.map((g) => g.id)).toEqual([...COUNTER_GROUP_PATHS]);
    expect(map.supportsDelta).toBe(true);
  });

  it("keeps every counter key verbatim, however well the catalog describes it", () => {
    // §11.2: the KEY IS DATA. Describing a counter must never turn its group
    // into a named-field record — the page binds the five groups explicitly
    // precisely so a hand-written description cannot change the renderer.
    const map = sectionById(zeroAll, "all") as DynamicMapSectionInstance;
    const core = map.groups.find((g) => g.id === "core");
    expect(core?.entries).toHaveLength(zeroCoreScalarCount);
    expect(core?.entries.every((e) => e.path === `core.${e.key}`)).toBe(true);
    // …and the described live-shaped keys land in the same place.
    const live = {
      ...zeroAll,
      pool: { pool_swap_total: 4, refill_failed_total: 0 },
    } as unknown as ZeroAllData;
    const pool = (sectionById(live, "all") as DynamicMapSectionInstance).groups.find(
      (g) => g.id === "pool",
    );
    expect(pool?.entries.map((e) => e.key)).toEqual(["pool_swap_total", "refill_failed_total"]);
    expect(lookupField("pool.pool_swap_total").source).toBe("exact");
  });

  it("gives the three breakdown arrays sections of their own, never a nested row", () => {
    for (const id of [
      "connections_bad_by_class",
      "handshake_failures_by_class",
      "handshake_error_codes",
    ]) {
      expect(sectionById(zeroAll, id).kind, id).toBe("breakdown");
    }
    // An empty array is still a collection, and it says so instead of
    // vanishing or reading "0 items" (§10.3).
    const empty = sectionById(zeroAll, "handshake_error_codes") as CollectionSectionInstance;
    expect(empty.presence).toBe("empty");
    // The map gives the two class arrays away to the sections above it: they
    // are nested containers of `core`, and the explicit section wins (§12).
    const map = sectionById(zeroAll, "all") as DynamicMapSectionInstance;
    const core = map.groups.find((g) => g.id === "core");
    expect(core?.nested.map((n) => n.key).sort()).toEqual([
      "connections_bad_by_class",
      "handshake_failures_by_class",
    ]);
  });

  it("renders the response stamp as a row rather than only consuming it", () => {
    // The map is bound to the whole context, so without this section
    // `generated_at_epoch_secs` would be counted as consumed and drawn by
    // nobody — accounted for on paper and invisible on screen.
    const metadata = sectionById(zeroAll, "metadata") as ScalarSectionInstance;
    expect(metadata.rows.map((row) => row.path)).toEqual(["generated_at_epoch_secs"]);
    expect(describeField("generated_at_epoch_secs", ru).unit).toBe("timestamp");
  });

  it("counts the counters, not the breakdown elements", () => {
    // 21 + 16 + 55 + 11 + 8, with the two class arrays and the empty
    // handshake_error_codes excluded: they are breakdowns, not counters.
    expect(counterTotal(zeroAll)).toBe(110);
    expect(counterLeaves(zeroAll).every((leaf) => typeof leaf.value !== "object")).toBe(true);
    const values = (countersPageDefinition.summary ?? []).map((m) => m.value(zeroAll));
    expect(values[0]).toBe(110);
    expect(values[1]).toBe(nonZeroCounters(zeroAll));
    expect(values[3]).toBe(5);
  });

  it("counts only the error counters that have actually fired", () => {
    const quiet = {
      generated_at_epoch_secs: 1,
      core: { connections_total: 5 },
      upstream: { connect_fail_total: 0 },
      middle_proxy: {},
      pool: {},
      desync: {},
    } as unknown as ZeroAllData;
    expect(errorCounters(quiet)).toBe(0);
    const noisy = {
      ...quiet,
      upstream: { connect_fail_total: 3, connect_success_total: 900 },
    } as unknown as ZeroAllData;
    expect(errorCounters(noisy)).toBe(1);
    // …and a page with no answer yet shows «—», not a confident zero.
    expect(errorCounters(undefined)).toBeNull();
    expect(counterTotal(null)).toBeNull();
    expect(nonZeroCounters(undefined)).toBeNull();
  });

  it("shows a counter a future Telemt adds, described by its family (§8.2)", () => {
    const future = {
      ...zeroAll,
      pool: { ...zeroAll.pool, a_counter_from_a_future_telemt_total: 7 },
    } as unknown as ZeroAllData;
    const map = sectionById(future, "all") as DynamicMapSectionInstance;
    const pool = map.groups.find((g) => g.id === "pool");
    expect(pool?.entries.map((e) => e.key)).toContain("a_counter_from_a_future_telemt_total");
    const result = lookupField("pool.a_counter_from_a_future_telemt_total");
    // The family rule, not the neutral fallback: the panel says what a
    // `_total` suffix means and refuses to invent the rest (§8.2).
    expect(result.source).toBe("family");
    expect(describeField("pool.a_counter_from_a_future_telemt_total", ru).description).toBe(
      ru.details.fields.families.total,
    );
    expect(resolveFor(future).unknownPaths).toEqual([]);
  });
});

describe("checkpoint R5-Counters: completeness (§27.4, ruling R7)", () => {
  it("accounts for every leaf of the production dump", () => {
    const result = resolveFor(zeroAll);
    // 110 counters + the response stamp + 8 leaves in the two class arrays
    // + the empty handshake_error_codes.
    expect(result.allPaths.length).toBe(120);
    expect(result.lostPaths).toEqual([]);
    expect(
      result.unknownPaths,
      `unplaced counter paths:\n${result.unknownPaths.join("\n")}`,
    ).toEqual([]);
    expect(result.ignoredPaths).toEqual([]);
    expect(result.extractedFromScalars).toEqual([]);
  });

  it("keeps the tail empty for a build that reports a section we have never seen", () => {
    const future = {
      ...zeroAll,
      a_section_from_a_future_telemt: { some_total: 1 },
    } as unknown as ZeroAllData;
    const result = resolveFor(future);
    expect(result.lostPaths).toEqual([]);
    // An unknown SECTION is not silently dropped: the map owns the whole
    // context, so its leaves are consumed, and R2's extended-mode tail is
    // where a reader finds them if the map's five groups do not cover it.
    expect(result.consumedPaths).toContain("a_section_from_a_future_telemt.some_total");
  });
});
