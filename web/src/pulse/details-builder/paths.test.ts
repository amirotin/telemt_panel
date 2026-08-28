import { describe, expect, it } from "vitest";
import {
  hasPath,
  isUnderPath,
  joinPath,
  matchesPattern,
  patternSpecificity,
  readPath,
  splitPath,
  walkLeafPaths,
} from "./paths";
import { dcs } from "./__fixtures__";

describe("normalized paths", () => {
  it("tokenizes keys and array indices alike", () => {
    expect(splitPath("dcs[0].endpoint_writers[2].endpoint")).toEqual([
      "dcs",
      "0",
      "endpoint_writers",
      "2",
      "endpoint",
    ]);
    expect(splitPath("")).toEqual([]);
    expect(splitPath("load")).toEqual(["load"]);
  });

  it("round-trips through joinPath", () => {
    const path = "dcs[0].endpoint_writers[2].endpoint";
    expect(joinPath(splitPath(path))).toBe(path);
  });

  it("matches a wildcard segment against a key or an index", () => {
    expect(matchesPattern("dcs[0].rtt_ms", "dcs.*.rtt_ms")).toBe(true);
    expect(matchesPattern("dcs[11].rtt_ms", "dcs.*.rtt_ms")).toBe(true);
    expect(matchesPattern("dcs[0].load", "dcs.*.rtt_ms")).toBe(false);
  });

  it("never lets a wildcard span segments", () => {
    // No "**": a pattern that matched at any depth would start describing
    // fields it has never seen (spec §8.2).
    expect(matchesPattern("dcs[0].endpoint_writers[1].endpoint", "dcs.*.endpoint")).toBe(false);
  });

  it("ranks a more literal pattern above a more wildcarded one", () => {
    expect(patternSpecificity("dcs.*.endpoint_writers.*.endpoint")).toBeGreaterThan(
      patternSpecificity("dcs.*.*.*.endpoint"),
    );
  });

  it("treats prefixes segment-wise, not by string prefix", () => {
    expect(isUnderPath("load", "load")).toBe(true);
    expect(isUnderPath("load_average", "load")).toBe(false);
    expect(isUnderPath("dcs[0].rtt_ms", "dcs")).toBe(true);
    expect(isUnderPath("anything", "")).toBe(true);
  });

  it("reads and probes a path independently of its value", () => {
    const dc = dcs.dcs[0];
    expect(readPath(dcs, "dcs[0].dc")).toBe(dc.dc);
    expect(readPath(dcs, "dcs[99].dc")).toBeUndefined();
    // rtt_ms is present-and-null on some fixtures; hasPath must not confuse
    // that with the key being absent (§13.1).
    const withNull = { rtt_ms: null };
    expect(readPath(withNull, "rtt_ms")).toBeNull();
    expect(hasPath(withNull, "rtt_ms")).toBe(true);
    expect(hasPath({}, "rtt_ms")).toBe(false);
  });
});

describe("walkLeafPaths", () => {
  it("emits one leaf per scalar and keeps empty containers as leaves", () => {
    const leaves = walkLeafPaths({
      a: 1,
      b: { c: "x" },
      d: [],
      e: {},
      f: null,
      g: [1, 2],
    });
    expect(leaves.map((l) => `${l.path}:${l.kind}`)).toEqual([
      "a:scalar",
      "b.c:scalar",
      "d:empty-array",
      "e:empty-object",
      "f:null",
      "g[0]:scalar",
      "g[1]:scalar",
    ]);
  });

  it("skips undefined (Go's omitempty never reaches the wire)", () => {
    expect(walkLeafPaths({ a: undefined, b: 1 }).map((l) => l.path)).toEqual(["b"]);
  });

  it("walks the production DC fixture without losing a field", () => {
    const leaves = walkLeafPaths(dcs);
    // 12 DCs × 15 scalar fields + endpoints + endpoint_writers + 3 top-level.
    expect(leaves.length).toBeGreaterThan(200);
    expect(leaves.every((l) => l.path !== "")).toBe(true);
  });
});
