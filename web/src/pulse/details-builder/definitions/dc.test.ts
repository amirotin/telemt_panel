// Checkpoint R5-DC, the automatable half: the DC page's own §27.4
// completeness equation, on the production-size fixture.
//
//   all normalized paths − consumed − explicitly ignored = unknown tail
//
// and for a MIGRATED domain the tail must be EMPTY — everything the DC
// payload carries is described by the catalog and placed in a section by
// the definition (plan Task 6).

import { describe, expect, it } from "vitest";
import { ru } from "../../../i18n";
import { dcs, minimalAll } from "../__fixtures__";
import { resolveSections } from "../resolveSections";
import type { CollectionSectionInstance, ScalarSectionInstance } from "../resolveSections";
import {
  dcAttentionTone,
  dcEntityKey,
  dcPageDefinition,
  selectDcContext,
  type DcPagePayload,
} from "./dc";

const payload: DcPagePayload = { ...dcs, network_paths: minimalAll.network_path ?? [] };

function contextFor(key: string | undefined) {
  const context = selectDcContext(payload, key);
  if (context === null) throw new Error("fixture has no DC");
  return context;
}

function resolveFor(key: string | undefined) {
  return resolveSections({ definition: dcPageDefinition, context: contextFor(key) });
}

describe("DC page definition (spec §23.1)", () => {
  it("selects an entity for each of the twelve data centers", () => {
    expect(payload.dcs).toHaveLength(12);
    const keys = payload.dcs.map((dc) => dcEntityKey(dc));
    expect(new Set(keys).size).toBe(12);
    // Negative ids are real (§9: "DC IDs включают как положительные, так и
    // отрицательные"), so the key must not be parsed as a number anywhere.
    expect(keys).toContain("dc-1");
  });

  it("renders §23.1's fourteen routing fields, in the spec's order", () => {
    const routing = resolveFor("dc1").sections.find(
      (section): section is ScalarSectionInstance => section.id === "routing",
    );
    expect(routing?.rows.map((row) => row.path)).toEqual([
      "dc",
      "available_endpoints",
      "available_pct",
      "required_writers",
      "floor_min",
      "floor_target",
      "floor_max",
      "floor_capped",
      "alive_writers",
      "coverage_pct",
      "fresh_alive_writers",
      "fresh_coverage_pct",
      "rtt_ms",
      "load",
    ]);
  });

  it("gives endpoints[] and endpoint_writers[] their own blocks, never a scalar row", () => {
    const result = resolveFor("dc1");
    for (const id of ["endpoints", "endpoint_writers"]) {
      const section = result.sections.find((s) => s.id === id);
      expect(section?.kind, id).toBe("array");
      expect((section as CollectionSectionInstance).presence, id).toBe("present");
    }
    // §23.1: "endpoints и endpoint_writers не дублируются строками N items".
    const scalarPaths = result.sections
      .filter((section): section is ScalarSectionInstance => section.kind === "scalars")
      .flatMap((section) => section.rows.map((row) => row.path));
    expect(scalarPaths).not.toContain("endpoints");
    expect(scalarPaths).not.toContain("endpoint_writers");
  });

  it("puts the response metadata on the page rather than losing it with the entity", () => {
    const metadata = resolveFor("dc1").sections.find(
      (section): section is ScalarSectionInstance => section.id === "metadata",
    );
    expect(metadata?.rows.map((row) => row.path)).toEqual([
      "middle_proxy_enabled",
      // Present as a ROW even though the healthy fixture carries no value:
      // §13.1 makes "did not arrive" a state worth showing, and this is the
      // field that would explain a middle-proxy outage.
      "reason",
      "generated_at_epoch_secs",
    ]);
    expect(metadata?.rows.find((row) => row.path === "reason")?.present).toBe(false);
  });

  it("names every summary tile from the catalog, never from a raw key", () => {
    const context = contextFor("dc1");
    for (const metric of dcPageDefinition.summary ?? []) {
      expect(metric.label, metric.id).toBeUndefined();
      expect(metric.value(context), metric.id).not.toBeUndefined();
    }
    // …and each of those paths really does carry a short label.
    const shorts = ru.details.fields.shortLabels as unknown as Record<string, string | undefined>;
    for (const metric of dcPageDefinition.summary ?? []) {
      const path = metric.path ?? metric.id;
      expect(shorts[`dc.${path}`], path).toBeTruthy();
    }
  });

  it("tones the coverage tiles by the DC's own health", () => {
    const coverage = (dcPageDefinition.summary ?? []).find((m) => m.id === "coverage");
    const tone = coverage?.tone;
    expect(typeof tone).toBe("function");
    if (typeof tone !== "function") return;
    const healthy = contextFor("dc1");
    expect(tone({ ...healthy, coverage_pct: 100, alive_writers: 3 })).toBe("good");
    expect(tone({ ...healthy, coverage_pct: 80, alive_writers: 3 })).toBe("warn");
    expect(tone({ ...healthy, coverage_pct: 0, alive_writers: 0 })).toBe("bad");
  });

  it("marks an under-covered DC in the selector and leaves a healthy one unmarked", () => {
    const healthy = payload.dcs[0];
    expect(dcAttentionTone({ ...healthy, coverage_pct: 100, available_pct: 100, alive_writers: 3 })).toBeNull();
    expect(dcAttentionTone({ ...healthy, coverage_pct: 95, alive_writers: 3 })).toBe("warn");
    expect(dcAttentionTone({ ...healthy, alive_writers: 0 })).toBe("bad");
  });
});

describe("checkpoint R5-DC: completeness (§27.4, ruling R7)", () => {
  it.each(dcs.dcs.map((dc) => [dcEntityKey(dc)] as const))(
    "%s — the unknown tail is empty",
    (key) => {
      const result = resolveFor(key);
      expect(result.lostPaths).toEqual([]);
      expect(
        result.unknownPaths,
        `undescribed/unplaced DC paths:\n${result.unknownPaths.join("\n")}`,
      ).toEqual([]);
      expect(result.ignoredPaths).toEqual([]);
      expect(result.consumedPaths.length).toBe(result.allPaths.length);
    },
  );

  it("keeps the tail empty when the gated network path never arrives", () => {
    const ungated = selectDcContext({ ...dcs }, "dc1");
    if (ungated === null) throw new Error("fixture has no DC");
    const result = resolveSections({ definition: dcPageDefinition, context: ungated });
    expect(result.unknownPaths).toEqual([]);
    expect(result.lostPaths).toEqual([]);
  });
});
