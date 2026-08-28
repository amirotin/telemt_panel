import { describe, expect, it } from "vitest";
import { ru } from "../../../i18n";
import type { FilterDefinition } from "../model";
import {
  applyEntityFilters,
  groupsOf,
  matchesEntitySearch,
  orderByGroup,
  type EntityEntry,
} from "./entityList.helpers";

interface Writer {
  id: number;
  dc: number | null;
  state: string;
  degraded: boolean;
}

const writers: Writer[] = [
  { id: 1, dc: 1, state: "active", degraded: false },
  { id: 2, dc: -1, state: "active", degraded: true },
  { id: 3, dc: 1, state: "warm", degraded: false },
  { id: 4, dc: null, state: "draining", degraded: false },
];

const entries: EntityEntry[] = writers.map((item, index) => ({
  item,
  index,
  key: `w${item.id}`,
  identity: `writer #${item.id}`,
  status: item.state,
}));

const group = {
  key: (item: unknown) => {
    const dc = (item as Writer).dc;
    return dc === null ? "dc-none" : `dc${dc}`;
  },
  label: (id: string) => (id === "dc-none" ? "DC —" : `DC ${id.slice(2)}`),
};

describe("groupsOf (§23.2)", () => {
  it("enumerates only the groups the collection actually contains", () => {
    // A data center with no writer right now must not leave an empty chip
    // behind — "empty" and "absent" are different states (§10.3), and an
    // absent group is neither.
    expect(groupsOf(entries, group, ru)).toEqual([
      { id: "dc1", label: "DC 1", count: 2 },
      { id: "dc-1", label: "DC -1", count: 1 },
      { id: "dc-none", label: "DC —", count: 1 },
    ]);
  });

  it("orders the chips with the definition's own comparator", () => {
    const ordered = groupsOf(entries, { ...group, compare: (a, b) => a.localeCompare(b) }, ru);
    expect(ordered.map((g) => g.id)).toEqual(["dc-1", "dc-none", "dc1"]);
  });

  it("returns nothing at all when a section declares no grouping", () => {
    expect(groupsOf(entries, undefined, ru)).toEqual([]);
  });
});

describe("applyEntityFilters (§18.2)", () => {
  const filters: FilterDefinition<unknown>[] = [
    {
      key: "degraded",
      label: () => "degraded",
      predicate: (item) => (item as Writer).degraded,
    },
    {
      key: "state",
      label: () => "state",
      options: [{ value: "active", label: () => "active" }],
      predicate: (item, value) => (item as Writer).state === value,
    },
  ];

  it("passes everything through when no filter is set", () => {
    expect(applyEntityFilters(entries, filters, {})).toHaveLength(4);
    // `false` is how a chip records "off"; it must not filter to nothing.
    expect(applyEntityFilters(entries, filters, { degraded: false })).toHaveLength(4);
    // …and neither must the select's own "any" option.
    expect(applyEntityFilters(entries, filters, { state: "" })).toHaveLength(4);
  });

  it("applies every set filter together", () => {
    expect(applyEntityFilters(entries, filters, { degraded: true }).map((e) => e.key)).toEqual([
      "w2",
    ]);
    expect(applyEntityFilters(entries, filters, { state: "active" }).map((e) => e.key)).toEqual([
      "w1",
      "w2",
    ]);
    expect(
      applyEntityFilters(entries, filters, { state: "active", degraded: true }).map((e) => e.key),
    ).toEqual(["w2"]);
  });
});

describe("matchesEntitySearch (§18.1)", () => {
  it("searches identity and status, case-insensitively", () => {
    expect(matchesEntitySearch(entries[0], "")).toBe(true);
    expect(matchesEntitySearch(entries[0], "WRITER #1")).toBe(true);
    expect(matchesEntitySearch(entries[3], "draining")).toBe(true);
    expect(matchesEntitySearch(entries[0], "draining")).toBe(false);
  });
});

describe("orderByGroup", () => {
  it("lays the rows out group by group and keeps the payload order inside one", () => {
    const groups = groupsOf(entries, group, ru);
    expect(orderByGroup(entries, group, groups).map((e) => e.key)).toEqual([
      "w1",
      "w3",
      "w2",
      "w4",
    ]);
  });

  it("leaves an ungrouped list exactly as it arrived", () => {
    expect(orderByGroup(entries, undefined, []).map((e) => e.key)).toEqual([
      "w1",
      "w2",
      "w3",
      "w4",
    ]);
  });
});
