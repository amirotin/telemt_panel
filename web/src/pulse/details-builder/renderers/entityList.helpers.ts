// Grouping and filtering for an entity list (spec §9.3, §18.2, §23.2).
//
// Pure functions only: the renderer owns the chips and the headings, and
// these answer the two questions behind them — which groups exist, and
// which rows survive the active filters. Keeping them here is what lets the
// ME page's "46 writers across 12 data centers" behaviour be asserted
// without a DOM.

import type { Dict } from "../../../i18n";
import type { EntityGroupDefinition, FilterDefinition, FilterValue } from "../model";

export interface EntityEntry {
  item: unknown;
  index: number;
  key: string;
  identity: string;
  status: string | null;
}

export interface EntityGroup {
  id: string;
  label: string;
  count: number;
}

// groupsOf enumerates the groups a collection actually contains — never a
// fixed list, because a data center with no writer right now must not leave
// an empty chip behind (§10.3 keeps "empty" and "absent" apart, and an
// absent group is neither).
export function groupsOf(
  entries: readonly EntityEntry[],
  group: EntityGroupDefinition<unknown> | undefined,
  s: Dict,
): EntityGroup[] {
  if (!group) return [];
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const id = group.key(entry.item);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ids = [...counts.keys()];
  if (group.compare) ids.sort(group.compare);
  return ids.map((id) => ({
    id,
    label: group.label ? group.label(id, s) : id,
    count: counts.get(id) ?? 0,
  }));
}

/**
 * applyEntityFilters keeps only the filters that are actually SET, exactly
 * the way applyRankingFilters does: a §18.2 summary shortcut writes the same
 * page-state slot the chip toggles, so a tile and a control can never
 * disagree about what is filtered.
 */
export function applyEntityFilters(
  entries: readonly EntityEntry[],
  filters: readonly FilterDefinition<unknown>[] | undefined,
  values: Record<string, FilterValue>,
): EntityEntry[] {
  if (!filters || filters.length === 0) return [...entries];
  const active = filters.filter(
    (f) => Object.hasOwn(values, f.key) && values[f.key] !== false && values[f.key] !== "",
  );
  if (active.length === 0) return [...entries];
  return entries.filter((entry) =>
    active.every((filter) => filter.predicate(entry.item, values[filter.key] as FilterValue)),
  );
}

// matchesEntitySearch searches the identity and the status word — the two
// strings a compact row actually shows. §18.1 asks for the semantic id and
// safe values, and on an entity row those are the same thing.
export function matchesEntitySearch(entry: EntityEntry, query: string): boolean {
  if (query === "") return true;
  const q = query.toLowerCase();
  return (
    entry.identity.toLowerCase().includes(q) || (entry.status ?? "").toLowerCase().includes(q)
  );
}

/**
 * orderByGroup lays the rows out group by group WITHOUT splitting them into
 * separate collections: the result is still one flat list, so the paging
 * window, the roving focus and the "Показать ещё" count keep working
 * unchanged, and the renderer draws a heading wherever the group id changes.
 */
export function orderByGroup(
  entries: readonly EntityEntry[],
  group: EntityGroupDefinition<unknown> | undefined,
  groups: readonly EntityGroup[],
): EntityEntry[] {
  if (!group || groups.length === 0) return [...entries];
  const rank = new Map(groups.map((g, i) => [g.id, i]));
  return [...entries].sort((a, b) => {
    const ra = rank.get(group.key(a.item)) ?? 0;
    const rb = rank.get(group.key(b.item)) ?? 0;
    if (ra !== rb) return ra - rb;
    // Stable within a group: the payload's own order, which is Telemt's.
    return a.index - b.index;
  });
}
