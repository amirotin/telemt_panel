import { describe, expect, it } from "vitest";
import { summary, zeroAll } from "../__fixtures__";
import {
  breakdownTotal,
  buildBreakdownRows,
  pickDelta,
  readBreakdownPair,
} from "./breakdown.helpers";

describe("readBreakdownPair (spec §9.4, donor isClassTotalList)", () => {
  it("reads the donor's own shape from the production fixture", () => {
    const first = summary.connections_bad_by_class?.[0];
    expect(readBreakdownPair(first, 0)).toEqual({
      label: (first as { class: string }).class,
      total: (first as { total: number }).total,
    });
  });

  it("reads the other spellings Telemt uses for the same pair", () => {
    expect(readBreakdownPair({ stage: "handshake", total: 7 }, 0)).toEqual({
      label: "handshake",
      total: 7,
    });
    expect(readBreakdownPair({ code: 40, count: 2 }, 0)).toEqual({ label: "40", total: 2 });
    // The {key, value} pairs a dynamic-map group is turned into.
    expect(readBreakdownPair({ key: "queue_full_total", value: 3 }, 0)).toEqual({
      label: "queue_full_total",
      total: 3,
    });
  });

  it("reads a two-leaf record whose halves follow no known convention", () => {
    expect(readBreakdownPair({ bucket: "p99", hits: 12 }, 0)).toEqual({ label: "p99", total: 12 });
  });

  it("returns null for anything that is not a pair", () => {
    expect(readBreakdownPair("plain", 0)).toBeNull();
    expect(readBreakdownPair({ a: "x", b: "y" }, 0)).toBeNull();
    expect(readBreakdownPair([1, 2], 0)).toBeNull();
  });

  it("keeps a nameless counter rather than dropping it", () => {
    expect(readBreakdownPair({ total: 5, extra: true }, 3)).toEqual({ label: "[3]", total: 5 });
  });
});

describe("buildBreakdownRows", () => {
  const items = [
    { class: "b", total: 10 },
    { class: "c", total: 30 },
    { class: "a", total: 10 },
  ];

  it("sorts descending and breaks ties on the label, so equal counters never swap", () => {
    expect(buildBreakdownRows(items).map((r) => r.label)).toEqual(["c", "a", "b"]);
    // The same rows in a different payload order produce the same list.
    const reordered = [items[2], items[0], items[1]];
    expect(buildBreakdownRows(reordered).map((r) => r.label)).toEqual(["c", "a", "b"]);
  });

  it("weighs every row against the section total", () => {
    const rows = buildBreakdownRows(items);
    expect(rows.map((r) => r.percent)).toEqual([60, 20, 20]);
    expect(breakdownTotal(rows)).toBe(50);
  });

  it("reports no share at all when the whole breakdown is zero", () => {
    const rows = buildBreakdownRows([
      { class: "a", total: 0 },
      { class: "b", total: 0 },
    ]);
    // `0` stays a real value (§13.1); it is the SHARE that is undefined.
    expect(rows.map((r) => r.total)).toEqual([0, 0]);
    expect(rows.map((r) => r.percent)).toEqual([null, null]);
  });

  it("honours definition-supplied accessors over the heuristic", () => {
    const rows = buildBreakdownRows([{ class: "a", total: 1, other: 9 }], {
      label: (item) => `custom-${(item as { class: string }).class}`,
      total: (item) => (item as { other: number }).other,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("custom-a");
    expect(rows[0].total).toBe(9);
  });

  it("drops elements that are not pairs instead of rendering NaN", () => {
    expect(buildBreakdownRows(["x", 1, null])).toEqual([]);
  });

  it("reads the {class,total} arrays nested in the production counters dump", () => {
    const nested = (zeroAll.core as Record<string, unknown>)["connections_bad_by_class"];
    const rows = buildBreakdownRows(nested as unknown[]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => typeof r.label === "string" && typeof r.total === "number")).toBe(true);
  });
});

describe("pickDelta", () => {
  it("accepts the row's normalized path and the bare label, and nothing else", () => {
    expect(pickDelta({ "core.tls": 4 }, "core", "tls")).toBe(4);
    expect(pickDelta({ tls: 7 }, "core", "tls")).toBe(7);
    expect(pickDelta({ "core.other": 1 }, "core", "tls")).toBeUndefined();
    expect(pickDelta(undefined, "core", "tls")).toBeUndefined();
  });

  it("keeps a real zero delta, which is a value and not an absence", () => {
    expect(pickDelta({ "core.tls": 0 }, "core", "tls")).toBe(0);
  });
});
