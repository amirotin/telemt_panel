// Checkpoint R5-NAT, the automatable half: §23.5's primitive ArraySections
// and the §27.4 completeness equation over all three live STUN shapes
// (13 configured x 10 / 7 / 0 live — TELEMT_LIVE_API_DATA §15).

import { describe, expect, it } from "vitest";
import { ru } from "../../../i18n";
import { describeField } from "../fieldCatalog";
import {
  natStunConfiguredCount,
  natStunLive0,
  natStunLive10,
  natStunLive7,
} from "../__fixtures__";
import type { RuntimeNatStun } from "../../../realtime/topics";
import { classifyValue, resolveSections } from "../resolveSections";
import type { CollectionSectionInstance, ScalarSectionInstance } from "../resolveSections";
import { liveTone, natPageDefinition, reflectionAgeSecs } from "./nat";

function resolveFor(context: RuntimeNatStun) {
  return resolveSections({ definition: natPageDefinition, context });
}

function sectionById(context: RuntimeNatStun, id: string) {
  const section = resolveFor(context).sections.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no section ${id}`);
  return section;
}

describe("NAT/STUN page definition (spec §23.5)", () => {
  it("gives both server lists a block of one row per server (§10.1)", () => {
    const configured = sectionById(natStunLive10, "configured") as CollectionSectionInstance;
    expect(configured.kind).toBe("array");
    expect(configured.primitives).toBe(true);
    expect(configured.items).toHaveLength(natStunConfiguredCount);
    const live = sectionById(natStunLive10, "live") as CollectionSectionInstance;
    expect(live.items).toHaveLength(10);
    // Never comma-joined and never "N items": every element is an item of
    // its own, which is the whole of §10.1.
    expect(configured.items.every((item) => typeof item === "string")).toBe(true);
  });

  it("keeps an empty live list on screen instead of dropping it (§10.3)", () => {
    const live = sectionById(natStunLive0, "live") as CollectionSectionInstance;
    expect(live.presence).toBe("empty");
    // …and the configured list beside it is untouched, so a reader can see
    // that thirteen servers were asked and none answered.
    expect((sectionById(natStunLive0, "configured") as CollectionSectionInstance).items).toHaveLength(
      natStunConfiguredCount,
    );
    expect(describeField("servers.live_total", ru).zeroMeaning).toBe(
      ru.details.fields.zeroMeanings["nat.servers.live_total"],
    );
  });

  it("names both reflection families whether or not they answered (§13.1)", () => {
    const withBoth = sectionById(natStunLive10, "reflection") as ScalarSectionInstance;
    expect(withBoth.rows.map((r) => r.path)).toEqual([
      "reflection.v4.addr",
      "reflection.v4.age_secs",
      "reflection.v6.addr",
      "reflection.v6.age_secs",
    ]);
    expect(withBoth.rows.every((r) => r.present)).toBe(true);

    // With no reflection at all the four rows are STILL drawn — each one
    // absent, which the renderer prints as «не пришло в ответе» rather than
    // as a blank where a value belongs.
    const empty = sectionById(natStunLive0, "reflection") as ScalarSectionInstance;
    expect(empty.rows).toHaveLength(4);
    expect(empty.rows.every((r) => !r.present && r.value === undefined)).toBe(true);
  });

  it("owns the empty `reflection` object rather than leaking it to the tail", () => {
    // `{}` is a leaf of its own (§10.3); `alsoConsumes` is what keeps it
    // out of the unknown fallback without pretending a value rendered.
    const result = resolveFor(natStunLive0);
    expect(result.consumedPaths).toContain("reflection");
    expect(result.unknownPaths).toEqual([]);
  });

  it("tones the live tile by how many of the configured servers answered", () => {
    expect(liveTone(natStunLive10)).toBe("warn");
    expect(liveTone(natStunLive0)).toBe("bad");
    expect(liveTone({ ...natStunLive10, servers: { configured: [], live: [], live_total: 0 } })).toBe(
      "neutral",
    );
    const allLive = {
      ...natStunLive10,
      servers: {
        configured: natStunLive10.servers.configured,
        live: natStunLive10.servers.configured,
        live_total: natStunConfiguredCount,
      },
    };
    expect(liveTone(allLive)).toBe("good");
  });

  it("shows «—» for the reflection age when nothing has reflected yet", () => {
    expect(reflectionAgeSecs(natStunLive10)).toBe(41);
    expect(reflectionAgeSecs(natStunLive0)).toBeNull();
    expect(reflectionAgeSecs(null)).toBeNull();
  });

  it("reads the two bound records as records, never as counters maps", () => {
    expect(classifyValue(natStunLive10.flags, { path: "flags" })).toBe("object");
    expect(classifyValue(natStunLive10.servers, { path: "servers" })).toBe("object");
    expect(classifyValue(natStunLive10.servers.configured, { path: "servers.configured" })).toBe(
      "primitiveArray",
    );
  });
});

describe("checkpoint R5-NAT: completeness (§27.4, ruling R7)", () => {
  it.each([
    ["13 configured, 10 live (hvds)", natStunLive10, 31],
    ["13 configured, 7 live (1cent)", natStunLive7, 28],
    ["13 configured, none live (dhost)", natStunLive0, 20],
  ] as const)("accounts for every leaf: %s", (_name, context, total) => {
    const result = resolveFor(context as RuntimeNatStun);
    expect(result.allPaths.length).toBe(total);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths, `unplaced NAT paths:\n${result.unknownPaths.join("\n")}`).toEqual(
      [],
    );
    expect(result.ignoredPaths).toEqual([]);
    expect(result.extractedFromScalars).toEqual([]);
  });

  it("accounts for a half-reflected proxy: v4 answered, v6 did not", () => {
    // The shape §15 warns about — the leaf schema legitimately differs
    // between two healthy proxies, so the page must be complete on both.
    const v4Only: RuntimeNatStun = {
      ...natStunLive10,
      reflection: { v4: { addr: "198.51.100.7", age_secs: 41 } },
    };
    const result = resolveFor(v4Only);
    expect(result.allPaths.length).toBe(29);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual([]);
    const reflection = sectionById(v4Only, "reflection") as ScalarSectionInstance;
    expect(reflection.rows.map((r) => r.present)).toEqual([true, true, false, false]);
  });

  it("hands a field we have never seen to the tail instead of swallowing it", () => {
    const future = {
      ...natStunLive10,
      a_block_from_a_future_telemt: { some_total: 1 },
    } as unknown as RuntimeNatStun;
    const result = resolveFor(future);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual(["a_block_from_a_future_telemt.some_total"]);
    expect(result.consumedPaths).not.toContain("a_block_from_a_future_telemt.some_total");
  });
});
