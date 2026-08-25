import { describe, expect, it } from "vitest";
import { filterGroups, flattenToRows, formatPrimitive, group, humanizeKey } from "./rows";
import { ru as s } from "../../i18n";

describe("formatPrimitive", () => {
  it("renders null/undefined as an em dash", () => {
    expect(formatPrimitive(null, s)).toBe("—");
    expect(formatPrimitive(undefined, s)).toBe("—");
  });
  it("renders booleans as да/нет", () => {
    expect(formatPrimitive(true, s)).toBe("да");
    expect(formatPrimitive(false, s)).toBe("нет");
  });
  it("renders numbers via String(), NaN/Infinity as an em dash", () => {
    expect(formatPrimitive(0, s)).toBe("0");
    expect(formatPrimitive(42, s)).toBe("42");
    expect(formatPrimitive(Number.NaN, s)).toBe("—");
    expect(formatPrimitive(Number.POSITIVE_INFINITY, s)).toBe("—");
  });
  it("renders empty string as an em dash, other strings as-is", () => {
    expect(formatPrimitive("", s)).toBe("—");
    expect(formatPrimitive("ready", s)).toBe("ready");
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
    expect(flattenToRows({}, s)).toEqual([]);
  });

  it("flattens a flat object into one row per key", () => {
    expect(flattenToRows({ a: 1, b: true }, s)).toEqual([
      { key: "a", label: "a", value: "1" },
      { key: "b", label: "b", value: "да" },
    ]);
  });

  it("flattens nested objects with dotted paths", () => {
    const rows = flattenToRows({ writers: { contour: { warm: 2, active: 5 } } }, s);
    expect(rows).toEqual([
      { key: "writers.contour.warm", label: "writers.contour.warm", value: "2" },
      { key: "writers.contour.active", label: "writers.contour.active", value: "5" },
    ]);
  });

  it("collapses an array of primitives into one comma-joined row", () => {
    const rows = flattenToRows({ live: ["stun1.example", "stun2.example"] }, s);
    expect(rows).toEqual([
      { key: "live", label: "live", value: "stun1.example, stun2.example" },
    ]);
  });

  it("renders an empty array as an em dash, not zero rows silently dropped", () => {
    expect(flattenToRows({ live: [] }, s)).toEqual([{ key: "live", label: "live", value: "—" }]);
  });

  it("expands an array of objects into one flattened block per index", () => {
    const rows = flattenToRows({ dc_rtt: [{ dc: 2, alive_writers: 3 }, { dc: 4, alive_writers: 1 }] }, s);
    expect(rows).toEqual([
      { key: "dc_rtt[0].dc", label: "dc rtt[0].dc", value: "2" },
      { key: "dc_rtt[0].alive_writers", label: "dc rtt[0].alive writers", value: "3" },
      { key: "dc_rtt[1].dc", label: "dc rtt[1].dc", value: "4" },
      { key: "dc_rtt[1].alive_writers", label: "dc rtt[1].alive writers", value: "1" },
    ]);
  });

  it("treats null/undefined leaves as an em dash row", () => {
    expect(flattenToRows({ last_error: null }, s)).toEqual([
      { key: "last_error", label: "last error", value: "—" },
    ]);
  });

  it("a bare top-level null/undefined with no prefix yields no rows", () => {
    expect(flattenToRows(null, s)).toEqual([]);
    expect(flattenToRows(undefined, s)).toEqual([]);
  });
});

describe("group", () => {
  it("returns no groups when the source is null/undefined", () => {
    expect(group("ME pool — writers", null, s)).toEqual([]);
    expect(group("ME pool — writers", undefined, s)).toEqual([]);
  });

  it("wraps flattenToRows' output under the given title otherwise", () => {
    expect(group("Writers", { total: 3 }, s)).toEqual([
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
