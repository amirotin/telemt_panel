// Ranking mechanics (spec §9.6, §18, §19.2), kept out of the component so
// each rule is a fact a unit test can pin.

import type { FilterDefinition, FilterValue, SortState } from "../model";
import { readPath } from "../paths";

/** The synthetic sort key standing for the definition's own `score`. */
export const SCORE_SORT_KEY = "__score";

export interface RankedEntry {
  item: unknown;
  /** Stable SEMANTIC key (§5.3) — the reconciliation identity, never the index. */
  key: string;
  identity: string;
  meta: string | null;
  score: number;
  /** Position in the payload, the last tie-break before the key. */
  index: number;
}

/** How a disambiguated key is spelled: `user_01·k3f9q`, `user_01·k3f9q·2`. */
const KEY_SEPARATOR = "·";

// FNV-1a over the record's identifying text, base36 — short enough to keep
// a key readable in a React warning, wide enough that two different records
// practically never meet. A genuine meeting is still handled below.
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// identifyingText collects the record's STRING leaves, path and value, in a
// deterministic order. Strings are what names a record — `ja4`, `ja3_raw`,
// `scope`; numbers are what COUNTS it, and a counter moves on every frame,
// so a key derived from one would re-key its own row and defeat the freeze
// it exists to serve.
function identifyingText(value: unknown, path: string, out: string[]): void {
  if (typeof value === "string") {
    out.push(`${path}=${value}`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, i) => identifyingText(child, `${path}[${i}]`, out));
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    identifyingText((value as Record<string, unknown>)[key], `${path}.${key}`, out);
  }
}

// uniqueEntryKeys makes the reconciliation key unique BY CONSTRUCTION, and
// without ever reaching for the array index.
//
// A ranking is the one collection where the semantic key legitimately
// repeats: Telemt's `by_user` and `by_cidr` group fifty ClientHello records
// under fourteen users and eight subnets, so `scope` — the honest identity
// of a row — names several rows at once. Left alone, React draws duplicate
// keys, the frozen order replays one entry twice, and the detail surface
// opens the first namesake instead of the row that was clicked.
//
// The index is NOT the way out of that: Telemt hands these lists back
// sorted, so an index-bearing key changes for every row a re-sort moved,
// `applyFrozenOrder` reads them all as departures and appends them to the
// end — an order worse than no freeze at all. The disambiguator here is
// read from the record itself instead, so a moved row keeps its key.
//
// EVERY key carries the digest, not only one that repeats in this frame.
// Decorating just the duplicates would make the key a function of the
// frame's COMPOSITION rather than of the record: a row would be re-keyed
// the moment a namesake arrived or left, `applyFrozenOrder` would read the
// rename as a departure and append the survivor to the end, and a detail
// surface open on it would close under the reader's hands — the very
// failure the index-bearing key was rejected for. The price is a longer
// key in a React warning, which is the price already paid for duplicates.
export function uniqueEntryKeys(
  itemKeys: readonly string[],
  items: readonly unknown[],
): string[] {
  const candidates = itemKeys.map((key, i) => {
    const text: string[] = [];
    identifyingText(items[i], "", text);
    return `${key}${KEY_SEPARATOR}${digest(text.join("\u0000"))}`;
  });

  // Two records that are identical as far as their text goes — or, far less
  // likely, two whose digests collided — get an occurrence ordinal, the
  // only tie-break left. It is stable for as long as their relative order
  // is, and they are indistinguishable rows either way.
  const used = new Map<string, number>();
  return candidates.map((candidate) => {
    const count = (used.get(candidate) ?? 0) + 1;
    used.set(candidate, count);
    return count === 1 ? candidate : `${candidate}${KEY_SEPARATOR}${count}`;
  });
}

// numericColumns lists the record keys a ranking can be sorted by: the
// scalar NUMERIC leaves the records actually carry (§9.6's "sort by any
// numeric column"). Keys are read from the elements themselves rather than
// declared, so a field a future Telemt adds becomes sortable without anyone
// editing a definition.
//
// A key qualifies when it is numeric in at least one element and never a
// container in any of them; order follows the first element's key order,
// which is the order Telemt writes the record in.
export function numericColumns(items: readonly unknown[], sampleSize = 20): string[] {
  const sample = items.slice(0, sampleSize);
  const order: string[] = [];
  const numeric = new Set<string>();
  const rejected = new Set<string>();
  for (const item of sample) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (!order.includes(key)) order.push(key);
      if (typeof value === "number" && Number.isFinite(value)) numeric.add(key);
      else if (value !== null && typeof value === "object") rejected.add(key);
    }
  }
  return order.filter((key) => numeric.has(key) && !rejected.has(key));
}

function columnValue(entry: RankedEntry, key: string): number {
  if (key === SCORE_SORT_KEY) return entry.score;
  const value = readPath(entry.item, key);
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

// sortRanked is total and deterministic: value, then payload position, then
// key. Two elements with the same counter therefore keep the same relative
// order in every frame — §19.2's "SHOULD избегать постоянного визуального
// прыгания" starts with the comparator, not with the freeze.
export function sortRanked(
  entries: readonly RankedEntry[],
  sort: SortState | undefined,
): RankedEntry[] {
  const key = sort?.key ?? SCORE_SORT_KEY;
  const sign = sort?.direction === "asc" ? -1 : 1;
  return [...entries].sort((a, b) => {
    const av = columnValue(a, key);
    const bv = columnValue(b, key);
    // Compared before subtracting: two elements that both LACK the column
    // read as -Infinity, and -Infinity − -Infinity is NaN, which would make
    // the comparator inconsistent instead of falling through to the
    // tie-break.
    if (av !== bv) return (bv - av) * sign;
    if (a.index !== b.index) return a.index - b.index;
    return a.key.localeCompare(b.key);
  });
}

// applyFrozenOrder replays a captured order over the CURRENT collection
// (§19.2):
//
//   * an entity that is still there keeps its place — the row under the
//     reader's finger does not move;
//   * an entity that arrived is appended rather than inserted, so it is
//     visible ("новая entity добавляется без потери позиции") without
//     pushing anything down;
//   * an entity that disappeared is simply gone.
//
// The result becomes the next snapshot, which is what keeps an arrival
// pinned where it landed instead of hopping again on the following frame.
export function applyFrozenOrder(
  frozen: readonly string[],
  incoming: readonly string[],
): string[] {
  const present = new Set(incoming);
  const known = new Set(frozen);
  const kept = frozen.filter((key) => present.has(key));
  const added = incoming.filter((key) => !known.has(key));
  return [...kept, ...added];
}

// matchesRankingSearch — §18.1's haystack: the semantic id, the row's own
// meta line and whatever the definition declares as searchable terms.
export function matchesRankingSearch(
  entry: RankedEntry,
  query: string,
  terms?: (item: unknown) => string[],
): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  if (entry.identity.toLowerCase().includes(needle)) return true;
  if ((entry.meta ?? "").toLowerCase().includes(needle)) return true;
  if (terms) {
    for (const term of terms(entry.item)) {
      if (term.toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}

// applyRankingFilters applies only the filters that are actually SET.
// §18.2's summary shortcut writes into the very same store the section's own
// control writes into, so a tile and a chip can never disagree about what
// is filtered.
export function applyRankingFilters(
  entries: readonly RankedEntry[],
  filters: readonly FilterDefinition<unknown>[] | undefined,
  values: Record<string, FilterValue>,
): RankedEntry[] {
  if (!filters || filters.length === 0) return [...entries];
  const active = filters.filter((f) => Object.hasOwn(values, f.key) && values[f.key] !== false);
  if (active.length === 0) return [...entries];
  return entries.filter((entry) =>
    active.every((filter) => filter.predicate(entry.item, values[filter.key])),
  );
}
