// The field catalog (spec §8) — what a parameter MEANS, kept apart from
// what a page shows.
//
// Owner decision 2026-08-26 (06-ui.md): the descriptions live in the repo
// with a coverage test and a checklist item on every Telemt bump, precisely
// so a new Telemt field shows up as a failing test rather than as an
// undescribed row nobody notices. This module is the structure and the
// lookup; the prose lives in i18n/{ru,en}.ts under `details.fields`, so a
// description is bilingual by construction and cannot be pinned to Russian
// by a helper that forgot to take `s: Dict`.
//
// §8.2's resolution order, implemented literally:
//
//   1. exact normalized path            dcs[0].rtt_ms  -> "dc.rtt_ms"
//   2. wildcard path                    dcs.*.rtt_ms
//   3. endpoint-specific path           (entries scoped to a source id)
//   4. known counters family            *_total, *_bytes, *_pct, …
//   5. neutral fallback text            "Параметр Telemt; описания пока нет"
//
// Step 5 is a hard stop: the builder MUST NOT invent business meaning for a
// field it has never seen (§8.2).
//
// Seeded here: the whole DC domain as the worked example (~30 entries) plus
// the handful of ME writer fields the tests reference. Tasks 6–8 extend the
// catalog domain by domain; `fieldCatalog.coverage.test.ts` is what tells
// them which paths are still missing.

import type { Dict } from "../../i18n";
import type { DisplayMode } from "../../display-mode/mode";
import type { FormatterName } from "./formatting";
import type { FieldDefinition, FieldUnit } from "./model";
import { matchesPattern, patternSpecificity, walkLeafPaths } from "./paths";

/**
 * One catalog row. `path` may be exact or wildcarded; `descriptionKey`
 * indexes `Dict["details"]["fields"]["descriptions"]` and defaults to the
 * pattern itself, which is why most entries only need two properties.
 */
export interface FieldCatalogEntry {
  path: string;
  descriptionKey?: string;
  /** Label override; by default a renderer humanizes the last path segment. */
  label?: string;
  format?: FormatterName;
  unit?: FieldUnit;
  sensitive?: boolean;
  /** Text shown INSTEAD of an em dash when the value is null (§13.1). */
  nullMeaningKey?: string;
  /** Hint shown beside a real 0 (§13.1) — never instead of it. */
  zeroMeaningKey?: string;
  minMode?: DisplayMode;
}

/** Which of the five steps produced a match — asserted by the priority tests. */
export type FieldLookupSource = "exact" | "wildcard" | "endpoint" | "family" | "fallback";

export interface FieldLookupResult {
  source: FieldLookupSource;
  entry: FieldCatalogEntry | null;
  /** Set when step 4 matched: which counters family. */
  family?: CounterFamilyId;
}

export type CounterFamilyId =
  | "errorsTotal"
  | "total"
  | "bytes"
  | "milliseconds"
  | "seconds"
  | "percent"
  | "count";

interface CounterFamily {
  id: CounterFamilyId;
  /** Tested against the LAST path segment only — a family is a key-naming convention. */
  test: RegExp;
  format?: FormatterName;
  unit?: FieldUnit;
}

// Ordered most specific first: `handshake_errors_total` is an error counter,
// not merely a total, and `*_errors_total` must win over `*_total`.
const COUNTER_FAMILIES: CounterFamily[] = [
  { id: "errorsTotal", test: /_(errors?|failures?|drops?|timeouts?)_total$/, format: "integer" },
  { id: "total", test: /_total$/, format: "integer" },
  { id: "bytes", test: /_(bytes|octets)$/, unit: "bytes" },
  { id: "milliseconds", test: /_ms$/, unit: "milliseconds" },
  { id: "seconds", test: /_(secs|seconds)$/, unit: "seconds" },
  { id: "percent", test: /_pct$/, unit: "percent" },
  { id: "count", test: /_(count|current|gauge)$/, format: "integer" },
];

export interface FieldCatalog {
  /** Global entries, exact and wildcard alike. */
  entries: FieldCatalogEntry[];
  /** Entries scoped to one source/endpoint id — step 3. */
  byEndpoint: Record<string, FieldCatalogEntry[]>;
}

// --- the seeded catalog --------------------------------------------------

// The DC domain, keyed by BOTH spellings a page can be looking at: the
// payload-rooted `dcs.*.x` (the whole DcStatusData) and the entity-rooted
// bare `x` (one DcStatus, which is what the DC Details page's context is
// once an entity is selected). Both point at the same description key, so
// there is exactly one sentence per concept.
function dcField(field: string, extra: Omit<FieldCatalogEntry, "path" | "descriptionKey"> = {}) {
  const key = `dc.${field}`;
  return [
    { path: `dcs.*.${field}`, descriptionKey: key, ...extra },
    { path: field, descriptionKey: key, ...extra },
  ];
}

const DC_ENTRIES: FieldCatalogEntry[] = [
  { path: "middle_proxy_enabled", descriptionKey: "dc.middle_proxy_enabled", format: "boolean" },
  { path: "reason", descriptionKey: "dc.reason", format: "enum" },
  {
    path: "generated_at_epoch_secs",
    descriptionKey: "dc.generated_at_epoch_secs",
    unit: "timestamp",
  },
  { path: "dcs", descriptionKey: "dc.dcs" },
  ...dcField("dc", { format: "integer" }),
  ...dcField("endpoints"),
  { path: "dcs.*.endpoints.*", descriptionKey: "dc.endpoint", format: "address" },
  { path: "endpoints.*", descriptionKey: "dc.endpoint", format: "address" },
  ...dcField("endpoint_writers"),
  {
    path: "dcs.*.endpoint_writers.*.endpoint",
    descriptionKey: "dc.endpoint",
    format: "address",
  },
  { path: "endpoint_writers.*.endpoint", descriptionKey: "dc.endpoint", format: "address" },
  {
    path: "dcs.*.endpoint_writers.*.active_writers",
    descriptionKey: "dc.endpoint_writers.active_writers",
    format: "integer",
  },
  {
    path: "endpoint_writers.*.active_writers",
    descriptionKey: "dc.endpoint_writers.active_writers",
    format: "integer",
  },
  ...dcField("available_endpoints", { format: "integer" }),
  ...dcField("available_pct", { unit: "percent" }),
  ...dcField("required_writers", { format: "integer" }),
  ...dcField("floor_min", { format: "integer" }),
  ...dcField("floor_target", { format: "integer" }),
  ...dcField("floor_max", { format: "integer" }),
  ...dcField("floor_capped", { format: "boolean" }),
  ...dcField("alive_writers", { format: "integer", zeroMeaningKey: "dc.alive_writers" }),
  ...dcField("coverage_pct", { unit: "percent" }),
  ...dcField("fresh_alive_writers", { format: "integer" }),
  ...dcField("fresh_coverage_pct", { unit: "percent" }),
  // rtt_ms is the §13.1 poster child: null means "never measured", which is
  // NOT the same as "no data" — the catalog says so instead of an em dash.
  ...dcField("rtt_ms", { unit: "milliseconds", nullMeaningKey: "dc.rtt_ms" }),
  ...dcField("load", { format: "decimal" }),
  { path: "network_path.dc", descriptionKey: "dc.network_path.dc", format: "integer" },
  {
    path: "network_path.ip_preference",
    descriptionKey: "dc.network_path.ip_preference",
    format: "enum",
  },
  {
    path: "network_path.selected_addr_v4",
    descriptionKey: "dc.network_path.selected_addr_v4",
    format: "address",
  },
  {
    path: "network_path.selected_addr_v6",
    descriptionKey: "dc.network_path.selected_addr_v6",
    format: "address",
  },
];

// A few ME writer fields — enough for the wildcard-priority tests to run
// against the exact path spec §8.2 names as its example. The ME domain
// proper lands in Task 7.
const ME_ENTRIES: FieldCatalogEntry[] = [
  { path: "writers.*.rtt_ema_ms", descriptionKey: "me.writers.rtt_ema_ms", unit: "milliseconds" },
  { path: "writers.*.degraded", descriptionKey: "me.writers.degraded", format: "boolean" },
  {
    path: "writers.*.bound_clients",
    descriptionKey: "me.writers.bound_clients",
    format: "integer",
  },
];

export const DEFAULT_FIELD_CATALOG: FieldCatalog = {
  entries: [...DC_ENTRIES, ...ME_ENTRIES],
  byEndpoint: {},
};

// --- lookup --------------------------------------------------------------

interface CompiledCatalog {
  exact: Map<string, FieldCatalogEntry>;
  wildcard: FieldCatalogEntry[];
  endpointExact: Map<string, Map<string, FieldCatalogEntry>>;
  endpointWildcard: Map<string, FieldCatalogEntry[]>;
  cache: Map<string, FieldLookupResult>;
}

// compile splits the flat entry list into the three tables the lookup walks,
// sorting wildcards most-specific-first so the result never depends on the
// order somebody happened to type the entries in.
function compile(catalog: FieldCatalog): CompiledCatalog {
  const exact = new Map<string, FieldCatalogEntry>();
  const wildcard: FieldCatalogEntry[] = [];
  for (const entry of catalog.entries) {
    if (entry.path.includes("*")) wildcard.push(entry);
    else exact.set(entry.path, entry);
  }
  wildcard.sort((a, b) => patternSpecificity(b.path) - patternSpecificity(a.path));

  const endpointExact = new Map<string, Map<string, FieldCatalogEntry>>();
  const endpointWildcard = new Map<string, FieldCatalogEntry[]>();
  for (const [endpoint, entries] of Object.entries(catalog.byEndpoint)) {
    const ex = new Map<string, FieldCatalogEntry>();
    const wc: FieldCatalogEntry[] = [];
    for (const entry of entries) {
      if (entry.path.includes("*")) wc.push(entry);
      else ex.set(entry.path, entry);
    }
    wc.sort((a, b) => patternSpecificity(b.path) - patternSpecificity(a.path));
    endpointExact.set(endpoint, ex);
    endpointWildcard.set(endpoint, wc);
  }
  return { exact, wildcard, endpointExact, endpointWildcard, cache: new Map() };
}

// Memoization is per catalog OBJECT, not global: a test builds its own
// catalog and gets its own cache, and the default catalog is compiled once
// for the whole app. A WeakMap so a throwaway catalog is collectable.
const COMPILED = new WeakMap<FieldCatalog, CompiledCatalog>();

function compiled(catalog: FieldCatalog): CompiledCatalog {
  let c = COMPILED.get(catalog);
  if (!c) {
    c = compile(catalog);
    COMPILED.set(catalog, c);
  }
  return c;
}

/** Clears the memo for one catalog — only needed by tests that mutate one in place. */
export function resetFieldCatalogCache(catalog: FieldCatalog = DEFAULT_FIELD_CATALOG): void {
  COMPILED.delete(catalog);
}

export interface FieldLookupContext {
  /** Source/endpoint id for step 3. */
  endpoint?: string;
  catalog?: FieldCatalog;
}

export function counterFamilyFor(path: string): CounterFamily | null {
  const segments = path.split(/[.[\]]+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  for (const family of COUNTER_FAMILIES) {
    if (family.test.test(last)) return family;
  }
  return null;
}

// lookupField walks §8.2's five steps in order and reports WHICH step
// matched, so the priority is a testable fact rather than an implementation
// detail. Memoized per (endpoint, path).
export function lookupField(path: string, ctx: FieldLookupContext = {}): FieldLookupResult {
  const catalog = ctx.catalog ?? DEFAULT_FIELD_CATALOG;
  const c = compiled(catalog);
  const cacheKey = `${ctx.endpoint ?? ""} ${path}`;
  const hit = c.cache.get(cacheKey);
  if (hit) return hit;

  const result = resolve(path, ctx.endpoint, c);
  c.cache.set(cacheKey, result);
  return result;
}

function resolve(path: string, endpoint: string | undefined, c: CompiledCatalog): FieldLookupResult {
  // 1. exact normalized path
  const exact = c.exact.get(path);
  if (exact) return { source: "exact", entry: exact };

  // 2. wildcard path
  for (const entry of c.wildcard) {
    if (matchesPattern(path, entry.path)) return { source: "wildcard", entry };
  }

  // 3. endpoint-specific path
  if (endpoint) {
    const ex = c.endpointExact.get(endpoint)?.get(path);
    if (ex) return { source: "endpoint", entry: ex };
    for (const entry of c.endpointWildcard.get(endpoint) ?? []) {
      if (matchesPattern(path, entry.path)) return { source: "endpoint", entry };
    }
  }

  // 4. known counters family
  const family = counterFamilyFor(path);
  if (family) {
    return {
      source: "family",
      family: family.id,
      entry: { path, format: family.format, unit: family.unit },
    };
  }

  // 5. neutral fallback
  return { source: "fallback", entry: null };
}

// --- resolving to the spec's FieldDefinition ----------------------------

function description(result: FieldLookupResult, s: Dict): string {
  const table = s.details.fields.descriptions as unknown as Record<string, string | undefined>;
  if (result.source === "family" && result.family) {
    const families = s.details.fields.families as unknown as Record<string, string | undefined>;
    return families[result.family] ?? s.details.fields.fallback;
  }
  const key = result.entry?.descriptionKey ?? result.entry?.path;
  if (key) {
    const text = table[key];
    if (text) return text;
  }
  return s.details.fields.fallback;
}

// describeField turns a path into the spec's §8 FieldDefinition with its
// description already in the reader's language — the shape a renderer wants.
export function describeField(path: string, s: Dict, ctx: FieldLookupContext = {}): FieldDefinition {
  const result = lookupField(path, ctx);
  const entry = result.entry;
  const nulls = s.details.fields.nullMeanings as unknown as Record<string, string | undefined>;
  const zeros = s.details.fields.zeroMeanings as unknown as Record<string, string | undefined>;
  const nullMeaning = entry?.nullMeaningKey ? nulls[entry.nullMeaningKey] : undefined;
  const zeroMeaning = entry?.zeroMeaningKey ? zeros[entry.zeroMeaningKey] : undefined;
  return {
    path,
    ...(entry?.label !== undefined ? { label: entry.label } : {}),
    description: description(result, s),
    ...(entry?.format !== undefined ? { format: entry.format } : {}),
    ...(entry?.unit !== undefined ? { unit: entry.unit } : {}),
    ...(entry?.sensitive !== undefined ? { sensitive: entry.sensitive } : {}),
    ...(nullMeaning !== undefined ? { nullMeaning } : {}),
    ...(zeroMeaning !== undefined ? { zeroMeaning } : {}),
    ...(entry?.minMode !== undefined ? { minMode: entry.minMode } : {}),
  };
}

// --- coverage harness (ruling: catalog test + Telemt-bump checklist) -----

export interface CoverageRow {
  path: string;
  source: FieldLookupSource;
}

export interface CoverageReport {
  total: number;
  /** Paths resolved by step 1 or 2 — a real, hand-written description. */
  described: string[];
  /** Paths that only reached a counters family or the neutral fallback. */
  undescribed: string[];
  rows: CoverageRow[];
}

// catalogCoverage walks a whole fixture and reports which of its leaves the
// catalog actually describes. Tasks 6–8 point it at their own fixtures and
// drive `undescribed` to empty for their domain; today it is asserted on
// the DC fixture only.
//
// `pathPrefix` strips a payload-rooted prefix so the same fixture can be
// checked as the page's entity context sees it ("rtt_ms") rather than as
// the wire delivers it ("dcs[0].rtt_ms").
export function catalogCoverage(
  payload: unknown,
  ctx: FieldLookupContext & { pathPrefix?: string } = {},
): CoverageReport {
  const rows: CoverageRow[] = [];
  const seen = new Set<string>();
  for (const leaf of walkLeafPaths(payload, ctx.pathPrefix ?? "")) {
    if (seen.has(leaf.path)) continue;
    seen.add(leaf.path);
    rows.push({ path: leaf.path, source: lookupField(leaf.path, ctx).source });
  }
  const described = rows.filter((r) => r.source !== "fallback" && r.source !== "family");
  const undescribed = rows.filter((r) => r.source === "fallback" || r.source === "family");
  return {
    total: rows.length,
    described: described.map((r) => r.path),
    undescribed: undescribed.map((r) => r.path),
    rows,
  };
}
