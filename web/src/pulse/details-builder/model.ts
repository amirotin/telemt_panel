// The declarative model of the Details-page builder (spec §7–§9).
//
// A page definition is a TypeScript module, never server-delivered JSON
// (spec §7): that is what lets a definition carry typed selectors, typed
// item renderers and a compile-time guarantee that a field binding actually
// exists on the payload it claims to read.
//
// Two deliberate departures from the spec's literal TypeScript sketch, both
// forced by the panel being bilingual (06-ui.md, and the Cyrillic sweep in
// i18n/i18n.test.ts):
//
//   * `title`/`description` on a section are `(s: Dict) => string`, not
//     `string`. A literal here would pin every Details page to one
//     language, which the lint rule and the sweep test both forbid.
//   * field descriptions live in the i18n dictionaries and are addressed by
//     key from the field catalog (see fieldCatalog.ts); the spec's
//     `FieldDefinition` with a resolved `description: string` is what
//     `describeField()` returns.
//
// Nothing here renders: model.ts is types plus the two tiny predicates the
// resolver and the renderers share.

import type { DisplayMode } from "../../display-mode/mode";
import type { Dict } from "../../i18n";
import type { TopicName } from "../../realtime/types";
import type { FormatterName } from "./formatting";

/** A localized string produced from the active dictionary. */
export type Localized = (s: Dict) => string;

// --- data sources (spec §7.1) -------------------------------------------

export interface DataSourceDefinition {
  id: string;
  /** SSE topic this source reads (realtime/topics.ts), if any. */
  topic?: TopicName;
  /** REST endpoint this source reads (React Query), if any. */
  endpoint?: string;
  /**
   * A page fails to a page-level error only when a REQUIRED source is
   * unusable; an optional source going away degrades the page to `partial`
   * and leaves every other section working (spec §14: "Глобальная ошибка не
   * должна заменять доступные секции при partial response").
   */
  required: boolean;
  /** Normalized path to the payload's own generation timestamp, if it carries one. */
  freshnessPath?: string;
  /** Normalized path to the `Gated<T>`-shaped capability wrapper, if any. */
  capabilityPath?: string;
}

// --- page state (spec §7.2) ---------------------------------------------

export type FilterValue = string | boolean | string[];

export interface SortState {
  key: string;
  direction: "asc" | "desc";
  /**
   * Which section this sort belongs to. A page may carry several sortable
   * collections (Security has four rankings), and only one of them is being
   * sorted at a time — the one the reader is looking at. Leaving the slot
   * single and TAGGING it is what lets a §18.2 summary shortcut aim a sort
   * at a named section without giving every section its own state key.
   */
  sectionId?: string;
}

// PageState is the union of the two halves ruling R3 splits apart:
// `selectedEntityKey`/`activeTab` live in the URL search params (deep-link
// and share), everything else lives in route memory. It never holds a copy
// of the payload (spec §7.2) — a realtime frame replaces the payload
// without touching a single field here, which is the whole of §19.1.
export interface PageState {
  selectedEntityKey?: string;
  activeTab?: string;
  searchQuery: string;
  filters: Record<string, FilterValue>;
  sort?: SortState;
  expandedSections: ReadonlySet<string>;
  expandedRecords: ReadonlySet<string>;
  visibleLimits: Record<string, number>;
  /** Key of the record currently open in the AdaptiveDetailSurface, if any. */
  openSurfaceKey?: string;
}

// --- field catalog entries (spec §8) ------------------------------------

export type FieldUnit = "percent" | "milliseconds" | "seconds" | "bytes" | "timestamp";

// FieldDefinition is the spec's §8 shape with its `description` already
// resolved into the reader's language — what describeField() hands a
// renderer. The stored catalog entry (FieldCatalogEntry, fieldCatalog.ts)
// carries dictionary keys instead.
export interface FieldDefinition {
  path: string;
  label?: string;
  /**
   * Short human name for compact surfaces — the §6 summary tiles read it.
   * NEVER the row name: a §8.1 row shows Telemt's own field name, so `label`
   * stays the row-level override and this one is a separate register.
   */
  shortLabel?: string;
  description: string;
  format?: FormatterName;
  unit?: FieldUnit;
  sensitive?: boolean;
  nullMeaning?: string;
  zeroMeaning?: string;
  minMode?: DisplayMode;
}

// --- paging (spec §10.5, §18.3) -----------------------------------------

// PagingPolicy is progressive reveal, never numbered pages (§18.3). The
// defaults encode the spec's §10.5 table; a page definition may override
// any threshold.
export interface PagingPolicy {
  /** Items shown before the first "Показать ещё". */
  initial: number;
  /** How many more each reveal adds. */
  step: number;
  /** At/above this size the section renders collapsed by default. */
  collapseAbove: number;
  /** At/above this size a search box is mandatory. */
  searchRequiredAbove: number;
}

export const DEFAULT_PAGING: PagingPolicy = {
  initial: 20,
  step: 20,
  collapseAbove: 9,
  searchRequiredAbove: 21,
};

// pagingForSize applies the §10.5 table to a concrete collection size.
export function pagingForSize(
  size: number,
  policy: PagingPolicy = DEFAULT_PAGING,
): { expandedByDefault: boolean; searchRequired: boolean; visible: number } {
  return {
    expandedByDefault: size > 0 && size < policy.collapseAbove,
    searchRequired: size >= policy.searchRequiredAbove,
    visible: Math.min(size, policy.initial),
  };
}

// --- search / filter / sort (spec §18) ----------------------------------

export interface SearchDefinition<TItem> {
  /** Haystack for one item: semantic id, raw key, label, description, safe values (§18.1). */
  terms: (item: TItem) => string[];
  placeholder?: Localized;
}

export interface SortDefinition<TItem> {
  key: string;
  label: Localized;
  compare: (a: TItem, b: TItem) => number;
}

export interface FilterDefinition<TItem> {
  key: string;
  label: Localized;
  /** Only domain-relevant states get a control (§18.2): degraded, active, non-zero… */
  predicate: (item: TItem, value: FilterValue) => boolean;
  options?: Array<{ value: string; label: Localized }>;
}

// --- sections (spec §9) -------------------------------------------------

export type SectionKind =
  | "scalars"
  | "array"
  | "entityList"
  | "breakdown"
  | "timeline"
  | "ranking"
  | "dynamicMap"
  | "custom";

interface SectionCommon<T> {
  id: string;
  title: Localized;
  description?: Localized;
  /** Which DataSourceDefinition feeds this section, for per-source loading/error states. */
  sourceId?: string;
  /** The ONE visibility filter (06-ui.md); `undefined` means "always". */
  minMode?: DisplayMode;
  defaultExpanded?: boolean;
  /**
   * Extra normalized paths this section renders beyond its own `path`.
   * Consumed-path tracking (§12.5) reads this, so a section that folds a
   * sibling field into its rows does not leave that field in the unknown
   * tail.
   */
  alsoConsumes?: string[];
  /** Escape hatch used by definitions that build rows from a computed context. */
  select?: (context: T) => unknown;
}

// 9.1 ScalarSection — scalar leaves of a stable record ONLY. An array or an
// object bound here is extracted before render (§9.1, §12.7); the resolver
// enforces that rather than trusting the definition.
export interface ScalarFieldBinding<T> {
  path: string;
  select?: (context: T) => unknown;
  /** Overrides the field catalog for this one binding. */
  format?: FormatterName;
  unit?: FieldUnit;
  minMode?: DisplayMode;
}

export interface ScalarSectionDefinition<T> extends SectionCommon<T> {
  kind: "scalars";
  fields: ScalarFieldBinding<T>[];
}

// 9.2 ArraySection — the generic "this is a list, give it its own block"
// renderer (§10). `path` is the normalized path of the array itself, which
// is also what it consumes.
export interface ArraySectionDefinition<T, TItem = unknown> extends SectionCommon<T> {
  kind: "array";
  path: string;
  itemKey?: (item: TItem, index: number) => string;
  paging?: Partial<PagingPolicy>;
  search?: SearchDefinition<TItem>;
  sort?: SortDefinition<TItem>[];
}

/**
 * §23.2's "grouping по DC/status" on an entity list: the rows stay ONE
 * collection — one search, one paging window, one tab stop — and the group
 * only decides where a heading is drawn and which chip narrows the list.
 * Anything stronger (a group that owns its own paging) would break §19.2's
 * promise that a realtime frame cannot move a row out from under a reader.
 */
export interface EntityGroupDefinition<TItem> {
  /** Stable group id for one item; items sharing an id share a block. */
  key: (item: TItem) => string;
  /** Chip and heading text; defaults to the id itself. */
  label?: (key: string, s: Dict) => string;
  /** Orders the groups; without it they keep first-seen order. */
  compare?: (a: string, b: string) => number;
}

// 9.3 EntityListSection — writers, upstreams: one compact row opens the
// detail surface, which carries every remaining field.
export interface EntityListSectionDefinition<T, TItem = unknown> extends SectionCommon<T> {
  kind: "entityList";
  path: string;
  /** Group headings and chips over the same single collection (§23.2). */
  groupBy?: EntityGroupDefinition<TItem>;
  /** Stable semantic key — the reconciliation identity of §19.2, never the array index. */
  itemKey: (item: TItem, index: number) => string;
  identity: (item: TItem) => string;
  status?: (item: TItem) => string | null;
  /** 1–3 headline values shown on the compact row; everything else lives in the surface. */
  highlights?: string[];
  paging?: Partial<PagingPolicy>;
  search?: SearchDefinition<TItem>;
  sort?: SortDefinition<TItem>[];
  filters?: FilterDefinition<TItem>[];
}

// 9.4 BreakdownSection — `{class,total}` / `{stage,total}` pairs: ONE row
// per entity, never two KV rows (§9.4).
//
// `label`/`total` are optional because the shape is recognizable on its
// own: `readBreakdownPair` (renderers/breakdown.helpers.ts) is the
// generalized `isClassTotalList` donor, and a dynamic-map group bound here
// arrives as {key, value} pairs the same helper reads. A definition still
// overrides either accessor when the pair is spelled unusually.
export interface BreakdownSectionDefinition<T, TItem = unknown> extends SectionCommon<T> {
  kind: "breakdown";
  path: string;
  label?: (item: TItem) => string;
  total?: (item: TItem) => number;
  /** Lifetime counterpart shown beside a delta, where both exist. */
  lifetime?: (item: TItem) => number | null;
}

// 9.5 TimelineSection — initialization components, events: status, title,
// details and duration as one step.
export interface TimelineSectionDefinition<T, TItem = unknown> extends SectionCommon<T> {
  kind: "timeline";
  path: string;
  itemKey?: (item: TItem, index: number) => string;
  status: (item: TItem) => string;
  step: (item: TItem) => string;
  details?: (item: TItem) => string | null;
  durationMs?: (item: TItem) => number | null;
  atEpochMs?: (item: TItem) => number | null;
}

// 9.6 RankingSection — TLS fingerprints, connection leaders: rank, search,
// sort, progressive reveal, detail surface.
export interface RankingSectionDefinition<T, TItem = unknown> extends SectionCommon<T> {
  kind: "ranking";
  path: string;
  itemKey: (item: TItem, index: number) => string;
  identity: (item: TItem) => string;
  score: (item: TItem) => number;
  /**
   * The record key `score` reads, when it reads one. Naming it makes the
   * default sort ONE of the numeric columns instead of a synthetic extra
   * option — the render's sort control says «По total», not «По рангу».
   */
  scoreKey?: string;
  /** What the score counts, printed under the number ("observed"). */
  scoreLabel?: Localized;
  /** Secondary line under the identity: "seen 2 мин. назад · bad/probe 0". */
  meta?: (item: TItem, s: Dict) => string | null;
  paging?: Partial<PagingPolicy>;
  search?: SearchDefinition<TItem>;
  sort?: SortDefinition<TItem>[];
  /** Domain-relevant filters only (§18.2) — a summary tile MAY shortcut to one. */
  filters?: FilterDefinition<TItem>[];
}

// 9.7 DynamicMapSection — forward-compatible counters and maps with keys we
// have never seen. The key is DATA and is shown verbatim (§11.2).
export interface DynamicMapGroupDefinition {
  id: string;
  title: Localized;
  /** Normalized path of the sub-object that becomes this group. */
  path: string;
}

export interface DynamicMapSectionDefinition<T> extends SectionCommon<T> {
  kind: "dynamicMap";
  path: string;
  groups?: DynamicMapGroupDefinition[];
  /** Client-side delta between consecutive polls is available for this map (ruling R4). */
  supportsDelta?: boolean;
}

// 9.8 CustomSection — only where the standard renderers cannot express the
// semantics. Still bound by the shared loading/error/empty, responsive and
// a11y contracts (§9.8).
/**
 * Options a definition hands to its registered renderer verbatim.
 *
 * Narrow on purpose. A renderer draws DATA (§9.8) and a chart cannot read
 * the field catalog for a value it deliberately does not consume, so the
 * two things it cannot derive — the unit word and what its leading count
 * counts — are declared here instead of being guessed or left blank.
 */
export interface CustomRendererOptions {
  /** Unit word printed after a value: «мс», «%». */
  unit?: Localized;
  /** Names the leading count; a bare «12» reads as a code, not a quantity. */
  countLabel?: Localized;
}

export interface CustomSectionDefinition<T> extends SectionCommon<T> {
  kind: "custom";
  /** Renderer options; see CustomRendererOptions. */
  options?: CustomRendererOptions;
  /**
   * Renderer id resolved by the page's registry
   * (renderers/customRenderers.ts). An id nobody registered is NOT an
   * error: the section falls back to the generic node tree, so a chart that
   * has not shipped yet degrades to readable rows rather than a blank card.
   */
  renderer: string;
  /** Paths this custom renderer covers, for consumed-path tracking. */
  consumes: string[];
}

export type SectionDefinition<T> =
  | ScalarSectionDefinition<T>
  | ArraySectionDefinition<T>
  | EntityListSectionDefinition<T>
  | BreakdownSectionDefinition<T>
  | TimelineSectionDefinition<T>
  | RankingSectionDefinition<T>
  | DynamicMapSectionDefinition<T>
  | CustomSectionDefinition<T>;

// --- unknown fields (spec §24, ruling R2) -------------------------------

export interface UnknownFieldsPolicy {
  /** Ruling R2: the tail is extended-mode only — the mode scaffolding already exists. */
  minMode?: DisplayMode;
  /**
   * Paths deliberately dropped, each with a reason. This is the ONLY way a
   * field may disappear without being rendered (§24.2), and the reason is
   * asserted by the completeness test, not just documented.
   */
  ignore?: Array<{ path: string; reason: string }>;
  /** Show the raw JSON dump as the last fallback level (§24.1). */
  rawJson?: boolean;
}

export const DEFAULT_UNKNOWN_FIELDS_POLICY: Required<
  Pick<UnknownFieldsPolicy, "minMode" | "rawJson">
> = {
  minMode: "extended",
  rawJson: true,
};

// --- summary / navigation / freshness -----------------------------------

/**
 * A tile's tone. `warn`/`bad` are also announced in words and marked with a
 * glyph by SummaryGrid — §21 forbids encoding a status in colour alone.
 */
export type SummaryTone = "neutral" | "good" | "warn" | "bad";

export interface SummaryMetricDefinition<T> {
  id: string;
  /**
   * Normalized path the tile reads; defaults to `id`. It is what names the
   * tile through the field catalog, so a metric whose id already IS the
   * field name needs neither this nor `label`.
   */
  path?: string;
  /**
   * Tile name. Optional on purpose: with no label the catalog's short label
   * for `path` names the tile — the renders show "Fresh coverage", never
   * `fresh_coverage_pct` — and only a path the catalog knows nothing about
   * falls back to the raw key.
   */
  label?: Localized;
  value: (context: T) => number | string | null;
  format?: FormatterName;
  unit?: FieldUnit;
  /**
   * A fixed tone, or one derived from the context — the attention binding a
   * domain page needs: DC's coverage tile is amber at 95 % and red at 0 %,
   * which no constant can express. Evaluated during render, so a realtime
   * frame re-tones the tile without touching any page state.
   */
  tone?: SummaryTone | ((context: T) => SummaryTone);
  /** §18.2: a metric MAY be a shortcut to an EXISTING control — see SummaryShortcut. */
  shortcut?: SummaryShortcut;
  minMode?: DisplayMode;
}

/**
 * §18.2's interactive summary metric: the tile applies a filter and/or a
 * sort that the section ALREADY offers through its own control. Both halves
 * are deliberately expressed in the section's own vocabulary (a filter key
 * a FilterDefinition declares, a sort key a numeric column carries), so a
 * shortcut can never reach a state the ordinary control cannot reach —
 * which is what "рядом остаётся обычный filter control" means in practice.
 */
export interface SummaryShortcut {
  filter?: { key: string; value: FilterValue };
  /** `sectionId` names the collection to sort; without it the sort is ignored. */
  sort?: SortState;
}

export interface EntitySelectorDefinition<TPayload> {
  /** Normalized path of the entity collection. */
  path: string;
  /** Overrides `path` when the collection is computed rather than read. */
  select?: (payload: TPayload) => unknown[];
  /** Stable semantic key (§5.3) — survives reordering and realtime frames. */
  entityKey: (item: unknown, index: number) => string;
  label: (item: unknown) => string;
  /**
   * Marks an entity that needs attention in the selector itself — the amber
   * dot the DC render puts on the two under-covered data centers, so a
   * reader sees WHICH entity is unhealthy without opening all twelve.
   * `null` is the healthy default; the reason is a localized word shown to
   * a screen reader beside the dot (§21: never colour alone).
   */
  attention?: (item: unknown) => { tone: "warn" | "bad"; reason: Localized } | null;
}

export interface TabDefinition {
  id: string;
  label: Localized;
  /** Section ids shown under this tab; empty means "all remaining". */
  sections?: string[];
}

export interface NavigationDefinition<TPayload, TContext> {
  entities?: EntitySelectorDefinition<TPayload>;
  tabs?: TabDefinition[];
  /** Narrows the payload to the currently selected entity. */
  selectEntity?: (payload: TPayload, key: string | undefined) => TContext | null;
}

export interface FreshnessDefinition<TPayload> {
  /** Epoch MILLISECONDS — sources.ts normalizes seconds-based topics on the way in. */
  atEpochMs: (payload: TPayload) => number | null;
  /** Older than this and the page reads `stale` (§19.3). */
  staleAfterMs?: number;
}

// --- the page ------------------------------------------------------------

export interface DetailPageDefinition<TPayload, TContext = TPayload> {
  id: string;
  title: Localized;
  description?: Localized;

  sources: DataSourceDefinition[];
  selectContext?: (payload: TPayload, state: PageState) => TContext;

  freshness?: FreshnessDefinition<TPayload>;
  summary?: SummaryMetricDefinition<TContext>[];
  navigation?: NavigationDefinition<TPayload, TContext>;
  sections: SectionDefinition<TContext>[];

  unknownFields?: UnknownFieldsPolicy;
  initialState?: Partial<PageState>;
}

// --- shared predicates ---------------------------------------------------

// sectionPaths returns every normalized path a section declares it renders
// — the input to consumed-path tracking (§12.5).
export function sectionPaths<T>(section: SectionDefinition<T>): string[] {
  const extra = section.alsoConsumes ?? [];
  switch (section.kind) {
    case "scalars":
      return [...section.fields.map((f) => f.path), ...extra];
    case "custom":
      return [...section.consumes, ...extra];
    case "dynamicMap":
      return [section.path, ...(section.groups ?? []).map((g) => g.path), ...extra];
    default:
      return [section.path, ...extra];
  }
}

// isCollectionSection — the kinds whose payload is an array, i.e. the ones
// that must never degrade into a scalar row (§10, §12.7).
export function isCollectionSection(kind: SectionKind): boolean {
  return (
    kind === "array" ||
    kind === "entityList" ||
    kind === "breakdown" ||
    kind === "timeline" ||
    kind === "ranking"
  );
}
