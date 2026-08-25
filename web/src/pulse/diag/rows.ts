// Generic KVRow-group building blocks for the Диагностика drill-down pages
// (06-ui.md: "подстраницы вмещают полный состав данных каталога — KVRow-
// группы"). Telemt's runtime/upstreams/security payloads run 10-50+ fields
// deep across nested structs and arrays (see realtime/topics.ts); hand
// labeling every leaf in Russian is neither tractable nor useful for a
// diagnostics deep-dump aimed at an operator who already knows Telemt's own
// field names (the same reasoning internal/telemt/types_stats.go's
// ZeroSection doc comment gives for the counters page). flattenToRows is the
// completeness backbone every domain page uses for a struct's leaves; pages
// still hand-pick which sub-object becomes which named KVGroup, and hand-label
// the handful of fields that benefit from a Russian gloss (see each
// domain's own helpers.ts).

import type { Dict } from "../../i18n";

export interface KVRowItem {
  key: string;
  label: string;
  value: string;
  monospace?: boolean;
}

export interface KVGroup {
  title: string;
  rows: KVRowItem[];
}

// formatPrimitive renders one JSON leaf value the way every diagnostics
// table shows it — booleans through the active dictionary's common.yes/no,
// missing/empty as an em dash (matching shell/StatusStrip.helpers.ts's own
// precedent for that one punctuation character living inline rather than in
// a dictionary), everything else via String().
export function formatPrimitive(value: unknown, s: Dict): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? s.common.yes : s.common.no;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "—";
  if (typeof value === "string") return value === "" ? "—" : value;
  return String(value);
}

// humanizeKey turns a snake_case/dotted field path into a readable label.
// Deliberately NOT translated — these are Telemt's own internal
// field names shown verbatim for an operator who already knows them
// (matches internal/telemt/types_stats.go's ZeroSection doc comment:
// "display-only", shown as Telemt names them).
export function humanizeKey(key: string): string {
  return key.replace(/_/g, " ");
}

// flattenToRows walks a JSON-like value into a flat list of leaf rows, each
// labeled by its dotted/indexed path from `prefix`. This is the completeness
// backbone: no matter how deep or irregular a payload's shape is, every leaf
// value it carries ends up as exactly one row, so nothing lands in the
// generic dump silently unreadable. Arrays of primitives collapse to one
// comma-joined row (a list of DC ids, not one row per id); arrays of objects
// expand to one flattened sub-block per index instead.
export function flattenToRows(value: unknown, s: Dict, prefix = ""): KVRowItem[] {
  if (value === null || value === undefined) {
    return prefix ? [{ key: prefix, label: humanizeKey(prefix), value: "—" }] : [];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return prefix ? [{ key: prefix, label: humanizeKey(prefix), value: "—" }] : [];
    }
    if (value.every((v) => v === null || typeof v !== "object")) {
      return [
        {
          key: prefix,
          label: humanizeKey(prefix),
          value: value.map((v) => formatPrimitive(v, s)).join(", "),
        },
      ];
    }
    return value.flatMap((item, i) => flattenToRows(item, s, prefix ? `${prefix}[${i}]` : `[${i}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      flattenToRows(v, s, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [{ key: prefix, label: humanizeKey(prefix), value: formatPrimitive(value, s) }];
}

// group is a small builder used throughout the domain helpers below — skips
// emitting a group entirely when its source object is absent (null/undefined),
// so a gated-off or not-yet-loaded sub-payload doesn't leave an empty
// "Generations" heading with nothing under it.
export function group(title: string, source: unknown, s: Dict): KVGroup[] {
  if (source === null || source === undefined) return [];
  return [{ title, rows: flattenToRows(source, s) }];
}

// filterGroups implements the Счётчики page's key-search filter (and is
// reusable by any future domain page that wants one): a group survives if
// its title matches, or at least one of its rows' key/label/value matches
// the query (case-insensitive substring). Empty query returns every group
// unchanged. Groups with all rows filtered out are dropped entirely, not
// kept with zero rows.
export function filterGroups(groups: KVGroup[], query: string): KVGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => {
      if (g.title.toLowerCase().includes(q)) return g;
      const rows = g.rows.filter(
        (r) =>
          r.key.toLowerCase().includes(q) ||
          r.label.toLowerCase().includes(q) ||
          r.value.toLowerCase().includes(q),
      );
      return { title: g.title, rows };
    })
    .filter((g) => g.rows.length > 0);
}
