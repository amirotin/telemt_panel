import { describe, expect, it } from "vitest";
import { filterGroups, flattenToRows, formatPrimitive, group, humanizeKey } from "./rows";

describe("formatPrimitive", () => {
  it("renders null/undefined as an em dash", () => {
    expect(formatPrimitive(null)).toBe("—");
    expect(formatPrimitive(undefined)).toBe("—");
  });
  it("renders booleans as да/нет", () => {
    expect(formatPrimitive(true)).toBe("да");
    expect(formatPrimitive(false)).toBe("нет");
  });
  it("renders numbers via String(), NaN/Infinity as an em dash", () => {
    expect(formatPrimitive(0)).toBe("0");
    expect(formatPrimitive(42)).toBe("42");
    expect(formatPrimitive(Number.NaN)).toBe("—");
    expect(formatPrimitive(Number.POSITIVE_INFINITY)).toBe("—");
  });
  it("renders empty string as an em dash, other strings as-is", () => {
    expect(formatPrimitive("")).toBe("—");
    expect(formatPrimitive("ready")).toBe("ready");
  });
});

describe("humanizeKey", () => {
  it("replaces underscores with spaces", () => {
    expect(humanizeKey("active_generation")).toBe("active generation");
  });
  it("leaves dotted/indexed paths otherwise untouched", () => {
    expect(humanizeKey("writers.contour[0].warm")).toBe("writers.contour[0].warm");
  });
});

describe("flattenToRows", () => {
  it("returns no rows for an empty top-level object", () => {
    expect(flattenToRows({})).toEqual([]);
  });

  it("flattens a flat object into one row per key", () => {
    expect(flattenToRows({ a: 1, b: true })).toEqual([
      { key: "a", label: "a", value: "1" },
      { key: "b", label: "b", value: "да" },
    ]);
  });

  it("flattens nested objects with dotted paths", () => {
    const rows = flattenToRows({ writers: { contour: { warm: 2, active: 5 } } });
    expect(rows).toEqual([
      { key: "writers.contour.warm", label: "writers.contour.warm", value: "2" },
      { key: "writers.contour.active", label: "writers.contour.active", value: "5" },
    ]);
  });

  it("collapses an array of primitives into one comma-joined row", () => {
    const rows = flattenToRows({ live: ["stun1.example", "stun2.example"] });
    expect(rows).toEqual([
      { key: "live", label: "live", value: "stun1.example, stun2.example" },
    ]);
  });

  it("renders an empty array as an em dash, not zero rows silently dropped", () => {
    expect(flattenToRows({ live: [] })).toEqual([{ key: "live", label: "live", value: "—" }]);
  });

  it("expands an array of objects into one flattened block per index", () => {
    const rows = flattenToRows({ dc_rtt: [{ dc: 2, alive_writers: 3 }, { dc: 4, alive_writers: 1 }] });
    expect(rows).toEqual([
      { key: "dc_rtt[0].dc", label: "dc rtt[0].dc", value: "2" },
      { key: "dc_rtt[0].alive_writers", label: "dc rtt[0].alive writers", value: "3" },
      { key: "dc_rtt[1].dc", label: "dc rtt[1].dc", value: "4" },
      { key: "dc_rtt[1].alive_writers", label: "dc rtt[1].alive writers", value: "1" },
    ]);
  });

  it("treats null/undefined leaves as an em dash row", () => {
    expect(flattenToRows({ last_error: null })).toEqual([
      { key: "last_error", label: "last error", value: "—" },
    ]);
  });

  it("a bare top-level null/undefined with no prefix yields no rows", () => {
    expect(flattenToRows(null)).toEqual([]);
    expect(flattenToRows(undefined)).toEqual([]);
  });
});

describe("group", () => {
  it("returns no groups when the source is null/undefined", () => {
    expect(group("ME pool — writers", null)).toEqual([]);
    expect(group("ME pool — writers", undefined)).toEqual([]);
  });

  it("wraps flattenToRows' output under the given title otherwise", () => {
    expect(group("Writers", { total: 3 })).toEqual([
      { title: "Writers", rows: [{ key: "total", label: "total", value: "3" }] },
    ]);
  });
});

describe("filterGroups", () => {
  const groups = [
    { title: "Ядро", rows: [{ key: "connections_total", label: "connections total", value: "100" }] },
    { title: "Апстримы", rows: [{ key: "connect_attempt_total", label: "connect attempt total", value: "50" }] },
  ];

  it("returns every group unchanged for an empty query", () => {
    expect(filterGroups(groups, "")).toEqual(groups);
    expect(filterGroups(groups, "   ")).toEqual(groups);
  });

  it("keeps a whole group when its title matches", () => {
    expect(filterGroups(groups, "ядро")).toEqual([groups[0]]);
  });

  it("keeps only matching rows when the title doesn't match", () => {
    expect(filterGroups(groups, "attempt")).toEqual([groups[1]]);
  });

  it("matches case-insensitively against key/label/value", () => {
    expect(filterGroups(groups, "100")).toEqual([groups[0]]);
  });

  it("drops a group entirely when nothing in it matches", () => {
    expect(filterGroups(groups, "nonexistent")).toEqual([]);
  });
});
