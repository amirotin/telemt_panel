import { describe, expect, it } from "vitest";
import { tlsFingerprints } from "../__fixtures__";
import type { FilterDefinition } from "../model";
import {
  applyFrozenOrder,
  applyRankingFilters,
  matchesRankingSearch,
  numericColumns,
  sortRanked,
  uniqueEntryKeys,
  SCORE_SORT_KEY,
  type RankedEntry,
} from "./ranking.helpers";

function entry(key: string, score: number, index: number, item: unknown = {}): RankedEntry {
  return { key, score, index, item, identity: key, meta: null };
}

describe("numericColumns (spec §9.6 'sort by any numeric column')", () => {
  it("lists exactly the numeric leaves of the production TLS records", () => {
    expect(numericColumns(tlsFingerprints.by_fingerprint)).toEqual([
      "total",
      "auth_success",
      "bad_or_probe",
      "first_seen_epoch_secs",
      "last_seen_epoch_secs",
    ]);
  });

  it("never offers a string or a container as a sort column", () => {
    const columns = numericColumns([{ a: 1, b: "x", c: [1], d: { e: 2 } }]);
    expect(columns).toEqual(["a"]);
  });

  it("keeps a key that is numeric in at least one element", () => {
    expect(numericColumns([{ a: null }, { a: 3 }])).toEqual(["a"]);
  });
});

describe("sortRanked", () => {
  const entries = [entry("b", 10, 0), entry("c", 30, 1), entry("a", 10, 2)];

  it("defaults to the definition's score, descending", () => {
    expect(sortRanked(entries, undefined).map((e) => e.key)).toEqual(["c", "b", "a"]);
  });

  it("breaks ties on the payload position, then the semantic key", () => {
    // b and a both score 10; b came first in the payload and stays first.
    const first = sortRanked(entries, { key: SCORE_SORT_KEY, direction: "desc" });
    expect(first.map((e) => e.key)).toEqual(["c", "b", "a"]);
    // The SAME set delivered in another order sorts the same way for the
    // score, and only the payload position differs — which is what makes the
    // comparator total rather than arbitrary.
    const shuffled = [entries[2], entries[1], entries[0]];
    expect(sortRanked(shuffled, undefined).map((e) => e.key)).toEqual(["c", "b", "a"]);
  });

  it("sorts by an arbitrary numeric column", () => {
    const rows = [
      entry("x", 1, 0, { rtt: 40 }),
      entry("y", 2, 1, { rtt: 5 }),
      entry("z", 3, 2, { rtt: 90 }),
    ];
    expect(sortRanked(rows, { key: "rtt", direction: "desc" }).map((e) => e.key)).toEqual([
      "z",
      "x",
      "y",
    ]);
    expect(sortRanked(rows, { key: "rtt", direction: "asc" }).map((e) => e.key)).toEqual([
      "y",
      "x",
      "z",
    ]);
  });

  it("puts records that lack the column last instead of scrambling the list", () => {
    const rows = [entry("x", 1, 0, {}), entry("y", 2, 1, { rtt: 5 })];
    expect(sortRanked(rows, { key: "rtt", direction: "desc" }).map((e) => e.key)).toEqual([
      "y",
      "x",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [...entries];
    sortRanked(input, undefined);
    expect(input.map((e) => e.key)).toEqual(["b", "c", "a"]);
  });
});

describe("applyFrozenOrder (spec §19.2)", () => {
  it("keeps every surviving entity exactly where it was", () => {
    expect(applyFrozenOrder(["a", "b", "c"], ["c", "b", "a"])).toEqual(["a", "b", "c"]);
  });

  it("appends an entity that arrived, rather than inserting it", () => {
    expect(applyFrozenOrder(["a", "b"], ["new", "b", "a"])).toEqual(["a", "b", "new"]);
  });

  it("drops an entity that disappeared", () => {
    expect(applyFrozenOrder(["a", "b", "c"], ["a", "c"])).toEqual(["a", "c"]);
  });

  it("is idempotent, so a repeated frame does not shuffle an appended arrival", () => {
    const once = applyFrozenOrder(["a", "b"], ["new", "b", "a"]);
    expect(applyFrozenOrder(once, ["new", "b", "a"])).toEqual(once);
  });

  it("starts from the incoming order when nothing was frozen yet", () => {
    expect(applyFrozenOrder([], ["b", "a"])).toEqual(["b", "a"]);
  });
});

describe("matchesRankingSearch (spec §18.1)", () => {
  const row = entry("k", 1, 0, { ja3: "deadbeef" });
  const withMeta: RankedEntry = { ...row, identity: "ja4:abc", meta: "seen 2 мин · bad/probe 0" };

  it("matches the identity, the meta line and the declared terms", () => {
    expect(matchesRankingSearch(withMeta, "JA4")).toBe(true);
    expect(matchesRankingSearch(withMeta, "bad/probe")).toBe(true);
    expect(
      matchesRankingSearch(withMeta, "deadbeef", (item) => [(item as { ja3: string }).ja3]),
    ).toBe(true);
    expect(matchesRankingSearch(withMeta, "nothing")).toBe(false);
  });

  it("matches everything on an empty query", () => {
    expect(matchesRankingSearch(withMeta, "")).toBe(true);
  });
});

describe("applyRankingFilters (spec §18.2)", () => {
  const degraded: FilterDefinition<unknown> = {
    key: "degraded",
    label: () => "degraded",
    predicate: (item) => (item as { degraded?: boolean }).degraded === true,
  };
  const rows = [entry("a", 1, 0, { degraded: true }), entry("b", 2, 1, { degraded: false })];

  it("applies only the filters that are actually set", () => {
    expect(applyRankingFilters(rows, [degraded], {}).map((e) => e.key)).toEqual(["a", "b"]);
    expect(applyRankingFilters(rows, [degraded], { degraded: true }).map((e) => e.key)).toEqual([
      "a",
    ]);
  });

  it("treats an explicitly false value as 'the control is off'", () => {
    expect(applyRankingFilters(rows, [degraded], { degraded: false }).map((e) => e.key)).toEqual([
      "a",
      "b",
    ]);
  });

  it("ignores a filter key nobody declared", () => {
    expect(applyRankingFilters(rows, [degraded], { other: true }).map((e) => e.key)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("uniqueEntryKeys (spec §5.3, §19.2 — the reconciliation key)", () => {
  // The two production rankings whose semantic key genuinely repeats:
  // fifty ClientHello records under fourteen users and eight subnets.
  const byUser = tlsFingerprints.by_user;
  const byCidr = tlsFingerprints.by_cidr;
  const scopeOf = (row: { scope?: string }) => row.scope ?? "";

  it("names a record by the definition's key AND by the record itself", () => {
    const rows = tlsFingerprints.by_fingerprint;
    const keys = rows.map((row) => row.ja4);
    const unique = uniqueEntryKeys(keys, rows);
    // The digest is unconditional, so even a key that already names one
    // record carries it — but the identity stays legible at the front.
    expect(new Set(unique).size).toBe(rows.length);
    unique.forEach((key, i) => expect(key.startsWith(`${keys[i]}\u00b7`)).toBe(true));
  });

  it("makes the keys of the by_user ranking unique without touching the index", () => {
    const keys = uniqueEntryKeys(byUser.map(scopeOf), byUser);
    expect(new Set(byUser.map(scopeOf)).size).toBe(14);
    expect(keys).toHaveLength(byUser.length);
    expect(new Set(keys).size).toBe(byUser.length);
    // Every key still CARRIES its identity, so a duplicate is recognizable
    // rather than replaced by a synthetic id.
    keys.forEach((key, i) => expect(key.startsWith(scopeOf(byUser[i]))).toBe(true));
    expect(keys.some((key) => /#\d+$/.test(key))).toBe(false);
  });

  it("makes the keys of the by_cidr ranking unique too", () => {
    const keys = uniqueEntryKeys(byCidr.map(scopeOf), byCidr);
    expect(new Set(byCidr.map(scopeOf)).size).toBe(8);
    expect(new Set(keys).size).toBe(byCidr.length);
  });

  it("gives a MOVED record the same key it had before the re-sort", () => {
    const before = uniqueEntryKeys(byUser.map(scopeOf), byUser);
    const order = byUser.map((_row, i) => i).reverse();
    const resorted = order.map((i) => byUser[i]);
    const after = uniqueEntryKeys(resorted.map(scopeOf), resorted);
    order.forEach((source, target) => expect(after[target]).toBe(before[source]));
  });

  it("survives a counter changing on every record, which a live frame does", () => {
    const before = uniqueEntryKeys(byUser.map(scopeOf), byUser);
    const ticked = byUser.map((row) => ({ ...row, total: row.total + 7 }));
    expect(uniqueEntryKeys(ticked.map(scopeOf), ticked)).toEqual(before);
  });

  it("falls back to an occurrence ordinal for records that are truly identical", () => {
    const row = { scope: "user_01", ja4: "t13d", total: 1 };
    const keys = uniqueEntryKeys(["user_01", "user_01", "user_01"], [row, { ...row }, { ...row }]);
    expect(keys[0]).toMatch(/^user_01·[0-9a-z]+$/);
    expect(keys[1]).toBe(`${keys[0]}·2`);
    expect(keys[2]).toBe(`${keys[0]}·3`);
  });

  it("keeps a record's key when a namesake LEAVES or ARRIVES (\u00a719.2)", () => {
    // Rows 0, 14 and 28 of the fixture are all `user_01`.
    const [first, other, second, third] = [byUser[0], byUser[1], byUser[14], byUser[28]];
    expect(scopeOf(second)).toBe(scopeOf(first));
    expect(scopeOf(third)).toBe(scopeOf(first));
    const trio = [first, other, second];
    const withTwin = uniqueEntryKeys(trio.map(scopeOf), trio);
    // The namesake leaves: the survivor becomes the only `user_01` in the
    // frame, and must NOT be renamed for it — a rename reads to
    // applyFrozenOrder as a departure and closes an open surface.
    const pair = [other, second];
    expect(uniqueEntryKeys(pair.map(scopeOf), pair)).toEqual([withTwin[1], withTwin[2]]);
    // …and one more namesake arriving does not rename anybody either.
    const quartet = [first, other, second, third];
    expect(uniqueEntryKeys(quartet.map(scopeOf), quartet).slice(0, 3)).toEqual(withTwin);
  });

  it("keeps a record distinguishable by a string field apart from its namesake", () => {
    const keys = uniqueEntryKeys(
      ["user_01", "user_01"],
      [
        { scope: "user_01", ja4: "aaa", total: 9 },
        { scope: "user_01", ja4: "bbb", total: 9 },
      ],
    );
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => !key.endsWith("·2"))).toBe(true);
  });
});
