import { describe, expect, it } from "vitest";
import type { DetailPageDefinition } from "./model";
import { classifyValue, resolveSections } from "./resolveSections";
import type { CollectionSectionInstance, ScalarSectionInstance } from "./resolveSections";
import {
  dcAllFalsy,
  dcEndpointVariants,
  dcs,
  initialization,
  meWriters,
  minimalAll,
  summary,
  tlsFingerprints,
  zeroAll,
} from "./__fixtures__";
import {
  countersPageDefinition,
  dcPageDefinition,
  initializationPageDefinition,
  meWritersPageDefinition,
  minimalPageDefinition,
  summaryPageDefinition,
  tlsPageDefinition,
} from "./__fixtures__/definitions";

function sectionById(
  result: ReturnType<typeof resolveSections>,
  id: string,
): (typeof result.sections)[number] {
  const section = result.sections.find((s) => s.id === id);
  if (!section) throw new Error(`no section ${id}`);
  return section;
}

describe("classifyValue (spec §12.6)", () => {
  it("separates an array of primitives from an array of records", () => {
    expect(classifyValue(["a", "b"])).toBe("primitiveArray");
    expect(classifyValue([{ a: 1 }])).toBe("recordArray");
    expect(classifyValue([])).toBe("primitiveArray");
  });

  it("recognises a counters map by its all-numeric values", () => {
    expect(classifyValue({ a: 1, b: 2 })).toBe("dynamicMap");
    expect(classifyValue({ a: 1, b: "x" })).toBe("object");
    // One key is not a map worth showing as verbatim keys.
    expect(classifyValue({ a: 1 })).toBe("object");
  });

  it("keeps null and absent apart", () => {
    expect(classifyValue(null)).toBe("null");
    expect(classifyValue(undefined)).toBe("absent");
    expect(classifyValue(0)).toBe("scalar");
    expect(classifyValue(false)).toBe("scalar");
  });
});

describe("resolveSections on the DC fixture", () => {
  const result = resolveSections({ definition: dcPageDefinition, context: dcs.dcs[0] });

  it("never puts an array in a ScalarRow (§12.7)", () => {
    for (const section of result.sections) {
      if (section.kind !== "scalars") continue;
      for (const row of (section as ScalarSectionInstance).rows) {
        expect(Array.isArray(row.value)).toBe(false);
        expect(typeof row.value === "object" && row.value !== null).toBe(false);
      }
    }
  });

  it("extracts an array bound to a ScalarSection instead of rendering it (§9.1)", () => {
    expect(result.extractedFromScalars).toContain("endpoints");
    const identity = sectionById(result, "identity") as ScalarSectionInstance;
    expect(identity.rows.some((r) => r.path === "endpoints")).toBe(false);
  });

  it("gives the extracted array its own block", () => {
    const endpoints = sectionById(result, "endpoints") as CollectionSectionInstance;
    expect(endpoints.kind).toBe("array");
    expect(endpoints.primitives).toBe(true);
    expect(endpoints.items.length).toBe(dcs.dcs[0].endpoints.length);
  });

  it("keys an entity list by semantic identity, not by index (§19.2)", () => {
    const writers = sectionById(result, "endpoint-writers") as CollectionSectionInstance;
    expect(writers.itemKeys).toEqual(dcs.dcs[0].endpoint_writers.map((w) => w.endpoint));
  });

  it("loses nothing: all − consumed − ignored − unknown tail is empty (§27.4)", () => {
    expect(result.lostPaths).toEqual([]);
    expect(result.allPaths.length).toBe(
      result.consumedPaths.length + result.ignoredPaths.length + result.unknownPaths.length,
    );
  });

  it("shows no unknown tail when every path is consumed (§12.8)", () => {
    expect(result.unknownFields).toBeNull();
    expect(result.unknownPaths).toEqual([]);
    expect(result.sections.some((s) => s.kind === "unknownFields")).toBe(false);
  });

  it("puts the unknown tail last, closed, and extended-only when it exists (R2, §24.1)", () => {
    // Drop the floor section: its four fields then have nowhere to go but
    // the tail.
    const partial = resolveSections({
      definition: {
        ...dcPageDefinition,
        sections: dcPageDefinition.sections.filter((s) => s.id !== "floor"),
      },
      context: dcs.dcs[0],
    });
    const last = partial.sections[partial.sections.length - 1];
    expect(last.kind).toBe("unknownFields");
    expect(last.defaultExpanded).toBe(false);
    expect(last.minMode).toBe("extended");
    expect(partial.unknownPaths).toEqual([
      "floor_min",
      "floor_target",
      "floor_max",
      "floor_capped",
    ]);
    expect(partial.lostPaths).toEqual([]);
  });
});

describe("empty is not absent (spec §10.3)", () => {
  const definition: DetailPageDefinition<unknown, unknown> = {
    id: "t",
    title: () => "t",
    sources: [],
    sections: [
      { kind: "array", id: "endpoints", title: () => "e", path: "endpoints" },
    ],
  };

  it("reports an empty array as empty and an absent one as absent", () => {
    const empty = resolveSections({ definition, context: dcEndpointVariants.empty });
    const absent = resolveSections({ definition, context: dcEndpointVariants.absent });
    const one = resolveSections({ definition, context: dcEndpointVariants.one });
    expect((sectionById(empty, "endpoints") as CollectionSectionInstance).presence).toBe("empty");
    expect((sectionById(absent, "endpoints") as CollectionSectionInstance).presence).toBe("absent");
    expect((sectionById(one, "endpoints") as CollectionSectionInstance).presence).toBe("present");
  });

  it("keeps an empty array a leaf, so it cannot vanish from the accounting", () => {
    const empty = resolveSections({ definition, context: dcEndpointVariants.empty });
    expect(empty.allPaths).toContain("endpoints");
    expect(empty.lostPaths).toEqual([]);
  });
});

describe("falsy scalars survive resolution (spec §13.1)", () => {
  it("keeps null, false and 0 as rows with present:true", () => {
    const result = resolveSections({ definition: dcPageDefinition, context: dcAllFalsy });
    const identity = sectionById(result, "identity") as ScalarSectionInstance;
    const floor = sectionById(result, "floor") as ScalarSectionInstance;
    const rtt = identity.rows.find((r) => r.path === "rtt_ms");
    const load = identity.rows.find((r) => r.path === "load");
    const capped = floor.rows.find((r) => r.path === "floor_capped");
    expect(rtt).toEqual({ path: "rtt_ms", value: null, present: true });
    expect(load).toEqual({ path: "load", value: 0, present: true });
    expect(capped).toEqual({ path: "floor_capped", value: false, present: true });
  });

  it("marks a field the payload never carried as present:false", () => {
    const definition: DetailPageDefinition<unknown, unknown> = {
      id: "t",
      title: () => "t",
      sources: [],
      sections: [
        {
          kind: "scalars",
          id: "s",
          title: () => "s",
          fields: [{ path: "rtt_ms" }, { path: "not_sent" }],
        },
      ],
    };
    const rows = (
      sectionById(
        resolveSections({ definition, context: { rtt_ms: null } }),
        "s",
      ) as ScalarSectionInstance
    ).rows;
    expect(rows).toEqual([
      { path: "rtt_ms", value: null, present: true },
      { path: "not_sent", value: undefined, present: false },
    ]);
  });
});

describe("explicit ignore policy (spec §24.2)", () => {
  const result = resolveSections({ definition: summaryPageDefinition, context: summary });

  it("records the reason for every dropped path", () => {
    expect(result.ignoredPaths).toEqual([
      { path: "uptime_seconds", reason: "shown by the page header, not as a row" },
    ]);
    expect(result.unknownPaths).not.toContain("uptime_seconds");
    expect(result.lostPaths).toEqual([]);
  });
});

describe("the unknown tail keeps containers as containers (spec §11.3, §24.1)", () => {
  const result = resolveSections({
    definition: { id: "t", title: () => "t", sources: [], sections: [] },
    context: { group: { inner: 1 }, list: ["a", "b"], map: { x: 1, y: 2 }, leaf: true },
  });

  it("makes an object a group, an array an array block and a map a map", () => {
    const nodes = result.unknownFields?.nodes ?? [];
    const kinds = Object.fromEntries(nodes.map((n) => [n.key, n.kind]));
    expect(kinds).toEqual({ group: "group", list: "array", map: "map", leaf: "row" });
  });

  it("does not flatten — a nested array never becomes a scalar row", () => {
    const list = result.unknownFields?.nodes.find((n) => n.key === "list");
    expect(list?.kind).toBe("array");
    if (list?.kind === "array") {
      expect(list.primitives).toBe(true);
      expect(list.children.map((c) => c.kind)).toEqual(["row", "row"]);
    }
  });
});

describe("resolveSections is pure", () => {
  it("returns equal results for the same input and mutates nothing", () => {
    const before = JSON.stringify(dcs.dcs[0]);
    const a = resolveSections({ definition: dcPageDefinition, context: dcs.dcs[0] });
    const b = resolveSections({ definition: dcPageDefinition, context: dcs.dcs[0] });
    expect(a.allPaths).toEqual(b.allPaths);
    expect(a.unknownPaths).toEqual(b.unknownPaths);
    expect(JSON.stringify(dcs.dcs[0])).toBe(before);
  });
});

describe("every section kind resolves against a production-size fixture", () => {
  const cases: Array<[string, DetailPageDefinition<never, never>, unknown, string, number]> = [
    [
      "array (primitives)",
      dcPageDefinition as never,
      dcs.dcs[0],
      "endpoints",
      dcs.dcs[0].endpoints.length,
    ],
    [
      "array (records)",
      dcPageDefinition as never,
      dcs.dcs[0],
      "endpoint-writers",
      dcs.dcs[0].endpoint_writers.length,
    ],
    ["entityList", meWritersPageDefinition as never, meWriters, "writers", 46],
    ["timeline", initializationPageDefinition as never, initialization, "components", 16],
    ["ranking", tlsPageDefinition as never, tlsFingerprints, "by-fingerprint", 50],
    ["breakdown", summaryPageDefinition as never, summary, "connections-bad", 3],
  ];

  it.each(cases)("%s", (_name, definition, context, sectionId, size) => {
    const result = resolveSections({ definition, context: context as never });
    const section = sectionById(result, sectionId) as CollectionSectionInstance;
    expect(section.items.length).toBe(size);
    expect(result.lostPaths).toEqual([]);
  });

  it("dynamicMap groups the counters payload by its five sections", () => {
    const result = resolveSections({ definition: countersPageDefinition, context: zeroAll });
    const counters = sectionById(result, "counters");
    expect(counters.kind).toBe("dynamicMap");
    if (counters.kind === "dynamicMap") {
      expect(counters.groups.map((g) => g.id)).toEqual([
        "core",
        "upstream",
        "middle_proxy",
        "pool",
        "desync",
      ]);
      expect(counters.supportsDelta).toBe(true);
    }
    expect(result.lostPaths).toEqual([]);
  });

  it("custom sections consume the paths they declare", () => {
    const result = resolveSections({ definition: minimalPageDefinition, context: minimalAll });
    const custom = sectionById(result, "network-path");
    expect(custom.kind).toBe("custom");
    expect(custom.consumed.length).toBeGreaterThan(0);
    expect(result.unknownPaths.some((p) => p.startsWith("network_path"))).toBe(false);
    expect(result.lostPaths).toEqual([]);
  });
});
