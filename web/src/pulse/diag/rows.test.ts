import { describe, expect, it } from "vitest";
import { flattenToRows, formatPrimitive, group, humanizeKey } from "./rows";
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

  it("collapses a {class,total} list into one row per class instead of index rows", () => {
    const rows = flattenToRows(
      {
        connections_bad_by_class: [
          { class: "rate_limited", total: 812 },
          { class: "quota_exceeded", total: 9 },
        ],
      },
      s,
    );
    expect(rows).toEqual([
      {
        key: "connections_bad_by_class.rate_limited",
        label: "connections bad by class: rate_limited",
        value: "812",
      },
      {
        key: "connections_bad_by_class.quota_exceeded",
        label: "connections bad by class: quota_exceeded",
        value: "9",
      },
    ]);
  });

  it("still expands by index when the objects carry more than class/total", () => {
    const rows = flattenToRows({ by_class: [{ class: "tls", total: 1, stage: "handshake" }] }, s);
    expect(rows.map((r) => r.key)).toEqual([
      "by_class[0].class",
      "by_class[0].total",
      "by_class[0].stage",
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
