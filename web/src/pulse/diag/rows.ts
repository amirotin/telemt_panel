// Generic KVRow-group building blocks. Since the M4 details-builder wave the
// Диагностика pages are declarative DetailPages and no longer flatten
// anything; the remaining consumer is securityGroups (security.helpers.ts),
// which feeds /server/security's KVGroupList. Retained, not dead.
//
// Historical rationale for the flattening approach, which still applies to
// that one screen:
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

// ClassTotal is Telemt's recurring `*_by_class` array element — a class name
// and its counter (StatsSummary.connections_bad_by_class /
// handshake_failures_by_class). Flattened by index it produces the unreadable
// "connections bad by class[0].class" / "[0].total" pair of rows; the
// name and its number belong on ONE row.
interface ClassTotal {
  class: string;
  total: number;
}

function isClassTotalList(value: unknown[]): value is ClassTotal[] {
  return value.every((v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const entry = v as Record<string, unknown>;
    return (
      Object.keys(entry).length === 2 &&
      typeof entry["class"] === "string" &&
      typeof entry["total"] === "number"
    );
  });
}

// flattenToRows walks a JSON-like value into a flat list of leaf rows, each
// labeled by its dotted/indexed path from `prefix`. This is the completeness
// backbone: no matter how deep or irregular a payload's shape is, every leaf
// value it carries ends up as exactly one row, so nothing lands in the
// generic dump silently unreadable. Arrays of primitives collapse to one
// comma-joined row (a list of DC ids, not one row per id); a `{class, total}`
// list collapses to one row per class (a compact two-column class → total
// list, the shape an operator actually reads it as); any other array of
// objects expands to one flattened sub-block per index.
export function flattenToRows(value: unknown, s: Dict, prefix = ""): KVRowItem[] {
  if (value === null || value === undefined) {
    return prefix ? [{ key: prefix, label: humanizeKey(prefix), value: "—" }] : [];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return prefix ? [{ key: prefix, label: humanizeKey(prefix), value: "—" }] : [];
    }
    if (prefix && isClassTotalList(value)) {
      // The class stays in the label rather than becoming its own row, so
      // the group reads as "<field>: <class> → N" and two different
      // *_by_class arrays in one group can't be confused for each other.
      return value.map((entry) => ({
        key: `${prefix}.${entry.class}`,
        label: `${humanizeKey(prefix)}: ${entry.class}`,
        value: String(entry.total),
      }));
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
