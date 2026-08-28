import { describe, expect, it } from "vitest";
import type { DetailPageDefinition } from "./model";
import { classifyValue, resolveSections } from "./resolveSections";
import { TLS_FINGERPRINTS_ENDPOINT } from "./fieldCatalog";
import type { CollectionSectionInstance, ScalarSectionInstance } from "./resolveSections";
import {
  dcAllFalsy,
  dcEndpointVariants,
  dcs,
  effectiveLimits,
  events,
  gates,
  initialization,
  mePoolState,
  meQuality,
  meRuntime,
  meSelftest,
  meWriters,
  minimalAll,
  posture,
  selftestAllNullable,
  summary,
  tlsFingerprints,
  whitelist,
  writerAllNull,
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

  it("recognises a counters map by its undescribed all-numeric keys", () => {
    expect(classifyValue({ a: 1, b: 2 })).toBe("dynamicMap");
    expect(classifyValue({ a: 1, b: "x" })).toBe("object");
    // One key is not a map worth showing as verbatim keys.
    expect(classifyValue({ a: 1 })).toBe("object");
    // …and neither is one numeric leaf beside a nested container.
    expect(classifyValue({ a: 1, b: { c: 2, d: 3 } })).toBe("object");
  });

  it("keeps null and absent apart", () => {
    expect(classifyValue(null)).toBe("null");
    expect(classifyValue(undefined)).toBe("absent");
    expect(classifyValue(0)).toBe("scalar");
    expect(classifyValue(false)).toBe("scalar");
  });
});

// The review's M1 table, as a test. The one-line "all values are numbers"
// rule got three of these wrong; every row below is a real Task 1 fixture.
describe("classifyValue on the production fixtures (review M1)", () => {
  const cases: Array<[string, unknown, string, string]> = [
    // All FIVE zero/all sections are counters maps — including the two the
    // old predicate missed because of a nested array.
    ["zeroAll.core (21 counters + 2 {class,total} arrays)", zeroAll.core, "core", "dynamicMap"],
    ["zeroAll.upstream", zeroAll.upstream, "upstream", "dynamicMap"],
    [
      "zeroAll.middle_proxy (54 counters + empty handshake_error_codes)",
      zeroAll.middle_proxy,
      "middle_proxy",
      "dynamicMap",
    ],
    ["zeroAll.pool", zeroAll.pool, "pool", "dynamicMap"],
    ["zeroAll.desync", zeroAll.desync, "desync", "dynamicMap"],
    // A typed record that happens to be all-numeric: the catalog describes
    // its keys, so it is NOT a verbatim-key map.
    ["meQuality.dc_rtt[0]", meQuality.dc_rtt[0], "dc_rtt[0]", "object"],
    // Counter maps inside ME Quality, which nobody has described.
    ["meQuality.counters", meQuality.counters, "counters", "dynamicMap"],
    ["meQuality.route_drops", meQuality.route_drops, "route_drops", "dynamicMap"],
    // {label,total} pairs stay arrays of records — BreakdownSection's input.
    [
      "summary.connections_bad_by_class",
      summary.connections_bad_by_class,
      "connections_bad_by_class",
      "recordArray",
    ],
    [
      "summary.handshake_failures_by_class",
      summary.handshake_failures_by_class,
      "handshake_failures_by_class",
      "recordArray",
    ],
    [
      "one {class,total}",
      summary.connections_bad_by_class?.[0],
      "connections_bad_by_class[0]",
      "object",
    ],
    // Stable records with a described key or a non-numeric leaf.
    ["dcs.dcs[0]", dcs.dcs[0], "dcs[0]", "object"],
    ["minimalAll.network_path[0]", minimalAll.network_path?.[0], "network_path[0]", "object"],
    ["zeroAll (root)", zeroAll, "", "object"],
    // Edge fixtures.
    ["dcAllFalsy", dcAllFalsy, "dcs[0]", "object"],
    ["writerAllNull", writerAllNull, "writers[0]", "object"],
    ["selftestAllNullable.ip (empty object)", selftestAllNullable.ip, "ip", "object"],
    ["zeroAll.middle_proxy.handshake_error_codes", [], "handshake_error_codes", "primitiveArray"],
    // Task 4's semantic renderers describe these four; the classification
    // they rely on is asserted here rather than assumed by the renderer.
    // A TLS record is a stable object (its identity leaves are strings),
    // which is why RankingSection reads named fields off it.
    [
      "tlsFingerprints.by_fingerprint[0]",
      tlsFingerprints.by_fingerprint[0],
      "by_fingerprint[0]",
      "object",
    ],
    ["tlsFingerprints.by_ip[0] (carries a scope)", tlsFingerprints.by_ip[0], "by_ip[0]", "object"],
    // An initialization step and an event are objects too — a timeline
    // reads status/title/details/duration off them by name.
    [
      "initialization.components[0]",
      initialization.components[0],
      "components[0]",
      "object",
    ],
    ["events.events[0]", events.events[0], "events[0]", "object"],
    // The two maps a BreakdownSection may be bound to instead of an array:
    // verbatim keys with counters, i.e. exactly §9.4's label → total.
    ["meQuality.route_drops (breakdown over a map)", meQuality.route_drops, "route_drops", "dynamicMap"],
    // --- Security domain, described by Task 6 -------------------------
    //
    // Task 2's review carry-over made this table load-bearing: a catalog
    // entry is criterion (c) of the dynamic-map test, so describing a
    // domain can FLIP a renderer. Every block the Security page binds is
    // pinned here, including the three all-numeric ones that would read as
    // verbatim-key counter maps without their descriptions.
    ["posture (mixed leaves)", posture, "posture", "object"],
    ["whitelist", whitelist, "whitelist", "object"],
    ["whitelist.entries (addresses)", whitelist.entries, "whitelist.entries", "primitiveArray"],
    ["effective_limits (nested groups only)", effectiveLimits, "effective_limits", "object"],
    // All seven leaves numeric — a described record, not a counters map.
    [
      "effective_limits.timeouts (7 numbers, all described)",
      effectiveLimits.timeouts,
      "effective_limits.timeouts",
      "object",
    ],
    [
      "effective_limits.upstream",
      effectiveLimits.upstream,
      "effective_limits.upstream",
      "object",
    ],
    [
      "effective_limits.user_ip_policy",
      effectiveLimits.user_ip_policy,
      "effective_limits.user_ip_policy",
      "object",
    ],
    // One key: never a map, whatever the catalog says (criterion a).
    [
      "effective_limits.user_tcp_policy (one key)",
      effectiveLimits.user_tcp_policy,
      "effective_limits.user_tcp_policy",
      "object",
    ],
    // The forward-compatible knob dump: mixed types, and the page binds it
    // to a DynamicMapSection explicitly rather than relying on this.
    [
      "effective_limits.middle_proxy (21 knobs, mixed types)",
      effectiveLimits.middle_proxy,
      "effective_limits.middle_proxy",
      "object",
    ],
    // --- ME domain, described by Task 7 -------------------------------
    //
    // Same carry-over as above, one domain larger: describing ~197 ME paths
    // flips criterion (c) for every all-numeric block the ME page binds, so
    // each of them is pinned here rather than assumed by its renderer.
    ["summary (9 numbers, all described)", meWriters.summary, "summary", "object"],
    ["writers[0] (16 mixed fields)", meWriters.writers[0], "writers[0]", "object"],
    ["gates (booleans and words)", gates, "gates", "object"],
    ["pool.writers (all-numeric, described)", mePoolState.writers, "pool.writers", "object"],
    [
      "pool.writers.contour (3 numbers, described)",
      mePoolState.writers.contour,
      "pool.writers.contour",
      "object",
    ],
    [
      "pool.generations (numbers + a null + an array)",
      mePoolState.generations,
      "pool.generations",
      "object",
    ],
    [
      "pool.generations.draining_generations (empty)",
      mePoolState.generations.draining_generations,
      "pool.generations.draining_generations",
      "primitiveArray",
    ],
    // The two ME quality blocks that WOULD read as verbatim-key counter maps
    // without their descriptions. Both are bound explicitly by the page — a
    // scalar block and a breakdown — so the classification only decides what
    // a future unbound sibling would look like.
    [
      "quality.counters (6 numbers, described)",
      meQuality.counters,
      "quality.counters",
      "object",
    ],
    [
      "quality.route_drops (5 numbers, described)",
      meQuality.route_drops,
      "quality.route_drops",
      "object",
    ],
    ["quality.dc_rtt[0]", meQuality.dc_rtt[0], "quality.dc_rtt[0]", "object"],
    [
      "quality.family_states[0]",
      meQuality.family_states[0],
      "quality.family_states[0]",
      "object",
    ],
    ["quality.drain_gate", meQuality.drain_gate, "quality.drain_gate", "object"],
    ["selftest.kdf", meSelftest.kdf, "selftest.kdf", "object"],
    ["selftest.pid (2 numbers-and-words)", meSelftest.pid, "selftest.pid", "object"],
    ["selftest.ip (nested families)", meSelftest.ip, "selftest.ip", "object"],
    ["me_runtime (55 knobs, all described)", meRuntime, "me_runtime", "object"],
    ["initialization.components[0]", initialization.components[0], "initialization.components[0]", "object"],
    // --- Counters domain, described by Task 7 -------------------------
    //
    // The counters keys are DATA (§11.2) and the page binds all five groups
    // to a DynamicMapSection explicitly, so describing them cannot change
    // what a reader sees. What the catalog DOES change is this classifier's
    // answer for an unbound sibling, and both readings are pinned: the
    // fixture's synthesized names resolve only by family (still a map), the
    // live-shaped names resolve exactly (a described record).
    ["zeroAll.pool (synthesized names)", zeroAll.pool, "pool", "dynamicMap"],
    [
      "pool with live-shaped names (described)",
      { pool_swap_total: 4, refill_failed_total: 0 },
      "pool",
      "object",
    ],
  ];

  it.each(cases)("%s -> %s", (_name, value, path, expected) => {
    expect(classifyValue(value, { path })).toBe(expected);
  });

  // The TLS capture bounds are the R9 case in miniature: `limit`,
  // `capacity`, `retention_secs`, `dropped_total`, `parse_error_total` are
  // five numbers under one root, which is a counters map to anyone who
  // cannot see the endpoint-scoped descriptions — and a stable record to
  // the Security page, which passes the scope. Asserted in both directions
  // because the page's ScalarSection depends on the second reading.
  it("reads the TLS root as a record only under its endpoint scope (R9)", () => {
    expect(classifyValue(tlsFingerprints, { path: "" })).toBe("dynamicMap");
    expect(
      classifyValue(tlsFingerprints, { path: "", endpoint: TLS_FINGERPRINTS_ENDPOINT }),
    ).toBe("object");
  });

  it("gives a counters map its nested containers as their own blocks, not rows", () => {
    const result = resolveSections({ definition: countersPageDefinition, context: zeroAll });
    const counters = sectionById(result, "counters");
    expect(counters.kind).toBe("dynamicMap");
    if (counters.kind !== "dynamicMap") return;
    const core = counters.groups.find((g) => g.id === "core");
    // The two {class,total} arrays are NOT among the verbatim key/value rows…
    expect(core?.entries.every((e) => typeof e.value === "number")).toBe(true);
    // …they are nested blocks, classified as arrays of records.
    expect(core?.nested.map((n) => n.key).sort()).toEqual([
      "connections_bad_by_class",
      "handshake_failures_by_class",
    ]);
    expect(core?.nested.every((n) => n.valueClass === "recordArray")).toBe(true);
    // The empty array in middle_proxy is a nested block too, not a row.
    const mp = counters.groups.find((g) => g.id === "middle_proxy");
    expect(mp?.nested.map((n) => n.key)).toEqual(["handshake_error_codes"]);
    expect(result.lostPaths).toEqual([]);
  });

  it("keeps a nested container in the unknown tail an array block, not a map row", () => {
    const result = resolveSections({
      definition: { id: "t", title: () => "t", sources: [], sections: [] },
      context: { core: zeroAll.core },
    });
    const map = result.unknownFields?.nodes.find((n) => n.key === "core");
    expect(map?.kind).toBe("map");
    if (map?.kind !== "map") return;
    expect(map.entries.every((e) => typeof e.value === "number")).toBe(true);
    expect(map.children.map((c) => c.kind)).toEqual(["array", "array"]);
    expect(result.lostPaths).toEqual([]);
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

describe("breakdown over a dynamic map (spec §9.4, §11.2)", () => {
  const definition: DetailPageDefinition<typeof meQuality, typeof meQuality> = {
    id: "test.route-drops",
    title: () => "route_drops",
    sources: [],
    sections: [
      { kind: "breakdown", id: "route-drops", title: () => "route_drops", path: "route_drops" },
    ],
  };

  it("turns the map's entries into {key, value} pairs and consumes the subtree", () => {
    const result = resolveSections({ definition, context: meQuality });
    const section = sectionById(result, "route-drops") as CollectionSectionInstance;
    expect(section.presence).toBe("present");
    expect(section.items).toHaveLength(Object.keys(meQuality.route_drops).length);
    expect(section.items[0]).toEqual({
      key: "no_conn_total",
      value: meQuality.route_drops.no_conn_total,
    });
    // Nothing leaks into the unknown tail, and nothing is lost.
    expect(result.unknownPaths.some((p) => p.startsWith("route_drops"))).toBe(false);
    expect(result.lostPaths).toEqual([]);
  });

  it("leaves a non-array bound to any OTHER collection kind alone", () => {
    const asArray: DetailPageDefinition<typeof meQuality, typeof meQuality> = {
      ...definition,
      sections: [
        { kind: "array", id: "route-drops", title: () => "route_drops", path: "route_drops" },
      ],
    };
    const result = resolveSections({ definition: asArray, context: meQuality });
    const section = sectionById(result, "route-drops") as CollectionSectionInstance;
    // An object is not a list: the section stays empty and the leaves are
    // still accounted for by the section that owns the path.
    expect(section.items).toEqual([]);
    expect(result.lostPaths).toEqual([]);
  });
});

describe("breakdown bound to elements that are NOT pairs (review L2)", () => {
  // `dcs` records carry nine fields each — the shape `readBreakdownPair`
  // deliberately refuses, so this section draws nothing at all.
  const definition: DetailPageDefinition<typeof dcs, typeof dcs> = {
    id: "test.not-pairs",
    title: () => "not pairs",
    sources: [],
    sections: [{ kind: "breakdown", id: "dcs", title: () => "dcs", path: "dcs" }],
    unknownFields: {},
  };

  it("does not swallow the subtree it cannot draw", () => {
    const result = resolveSections({ definition, context: dcs });
    const section = sectionById(result, "dcs") as CollectionSectionInstance;
    // The collection is genuinely there — it is the PAIRS that are missing.
    expect(section.presence).toBe("present");
    expect(section.items).toHaveLength(dcs.dcs.length);
    // …so the leaves stay unconsumed and reappear in the unknown tail,
    // which is exactly what the section's empty state promises.
    expect(result.consumedPaths.some((p) => p.startsWith("dcs"))).toBe(false);
    expect(result.unknownPaths.some((p) => p.startsWith("dcs["))).toBe(true);
    expect(result.lostPaths).toEqual([]);
  });

  it("still owns the subtree as soon as the definition names the pair", () => {
    const named: DetailPageDefinition<typeof dcs, typeof dcs> = {
      ...definition,
      sections: [
        {
          kind: "breakdown",
          id: "dcs",
          title: () => "dcs",
          path: "dcs",
          label: (item) => String((item as { dc: number }).dc),
          total: (item) => (item as { rtt_ms: number | null }).rtt_ms ?? 0,
        },
      ],
    };
    const result = resolveSections({ definition: named, context: dcs });
    expect(result.consumedPaths.some((p) => p.startsWith("dcs["))).toBe(true);
    expect(result.unknownPaths.some((p) => p.startsWith("dcs["))).toBe(false);
    expect(result.lostPaths).toEqual([]);
  });
});
