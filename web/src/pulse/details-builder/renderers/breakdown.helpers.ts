// Reading a `{label, total}` pair out of one collection element (spec §9.4).
//
// Donor: `isClassTotalList` in pulse/diag/rows.ts, which recognised exactly
// one spelling — `{class: string, total: number}` — and only to keep the
// flattener from emitting two rows per element. The rule generalizes: what
// makes a pair a pair is a NAME leaf and a COUNT leaf, whatever Telemt
// happens to call them (`class`/`stage`/`code`/`reason`, `total`/`count`/
// `value`), plus the {key, value} shape a dynamic-map group arrives as.
//
// Nothing here formats or renders: `readBreakdownPair` answers "what is the
// label and what is the number", `buildBreakdownRows` orders and weighs the
// result, and BreakdownSection draws it.

import { childPath } from "../paths";

/** Key names Telemt uses for the naming half of a breakdown pair. */
const LABEL_KEYS = ["class", "stage", "code", "reason", "kind", "type", "name", "key"] as const;

/** Key names Telemt uses for the counting half. */
const TOTAL_KEYS = ["total", "count", "value", "n"] as const;

export interface BreakdownPair {
  label: string;
  total: number;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

// readBreakdownPair returns null when the element is not a pair at all — a
// breakdown section bound to the wrong path then renders an honest empty
// state instead of a column of NaNs.
export function readBreakdownPair(item: unknown, index: number): BreakdownPair | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;

  const label = firstString(record, LABEL_KEYS);
  const total = firstNumber(record, TOTAL_KEYS);
  if (label !== null && total !== null) return { label, total };

  // A two-leaf record whose halves are not named by any known convention:
  // take the one string and the one number it does have. This is the case
  // a future Telemt field lands in, and it reads correctly without anyone
  // extending the tables above.
  const entries = Object.entries(record).filter(([, v]) => v !== undefined);
  if (entries.length === 2) {
    const strings = entries.filter(([, v]) => typeof v === "string");
    const numbers = entries.filter(([, v]) => typeof v === "number");
    if (strings.length === 1 && numbers.length === 1) {
      return { label: String(strings[0][1]), total: numbers[0][1] as number };
    }
  }

  // Last resort: the element carries a number under one of the counting
  // keys but nothing readable to name it — index it rather than lose it.
  if (total !== null) return { label: `[${index}]`, total };
  return null;
}

export interface BreakdownRow extends BreakdownPair {
  /** The element itself, for a definition-supplied lifetime accessor. */
  item: unknown;
  /** Stable key: the label, which is the semantic identity of a pair. */
  key: string;
  /** Share of the section total, 0–100. `null` when the total is 0. */
  percent: number | null;
}

export interface BreakdownRowOptions {
  label?: (item: unknown) => string;
  total?: (item: unknown) => number;
}

// buildBreakdownRows sorts DESC by total with a stable tie-break on the
// label (§19.2: a ranking may reorder, but two equal values must not swap
// places between two frames just because the payload's array order moved).
export function buildBreakdownRows(
  items: readonly unknown[],
  options: BreakdownRowOptions = {},
): BreakdownRow[] {
  const pairs: BreakdownRow[] = [];
  items.forEach((item, index) => {
    const read = readBreakdownPair(item, index);
    const label = options.label ? options.label(item) : read?.label;
    const total = options.total ? options.total(item) : read?.total;
    if (label === undefined || total === undefined || !Number.isFinite(total)) return;
    pairs.push({ item, label, key: label, total, percent: null });
  });

  const sum = pairs.reduce((acc, row) => acc + Math.max(0, row.total), 0);
  for (const row of pairs) {
    row.percent = sum > 0 ? (Math.max(0, row.total) / sum) * 100 : null;
  }
  pairs.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  return pairs;
}

// breakdownTotal — the Σ shown in the section header, over the SAME rows the
// body draws, so the two can never disagree.
export function breakdownTotal(rows: readonly BreakdownRow[]): number {
  return rows.reduce((acc, row) => acc + row.total, 0);
}

// pickDelta accepts both spellings a producer may key a delta by: the row's
// normalized path (the spelling DynamicMapSection's deltas already use) and
// the bare label. Never the index — a reordered payload would then move a
// delta onto another class.
export function pickDelta(
  deltas: Record<string, number> | undefined,
  path: string,
  label: string,
): number | undefined {
  if (deltas === undefined) return undefined;
  const scoped = childPath(path, label);
  if (Object.hasOwn(deltas, scoped)) return deltas[scoped];
  if (Object.hasOwn(deltas, label)) return deltas[label];
  return undefined;
}
