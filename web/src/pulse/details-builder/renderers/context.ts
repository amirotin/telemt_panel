// The render-side context every Details section renderer receives.
//
// Deliberately NOT the whole DetailPageStateApi: a renderer needs a clock,
// a display mode, a catalog scope and the handful of state operations it
// actually performs. Keeping the surface narrow is what lets a renderer
// test build a context from plain objects with no router and no reducer.

import type { DisplayMode } from "../../../display-mode";
import { visibleFor } from "../../../display-mode";
import type { FieldLookupContext } from "../fieldCatalog";
import type { AbsenceKind } from "../formatting";
import type { FilterValue, SortState } from "../model";
import type { DetailPageStateApi } from "../state";

/** Absence a SOURCE state forces onto every row it feeds (R5, §13.1). */
export type ForcedAbsence = Extract<AbsenceKind, "unsupported" | "unavailable">;

/**
 * SectionExtras is the page's live, section-scoped extension of a section a
 * DEFINITION cannot express, because all three parts need something a static
 * module does not have: a callback, or a value read off the payload.
 *
 * It exists for the WEB domain (M4 task 8b) and is deliberately generic:
 *
 *   * `badge` — a word beside the section title, derived from the payload.
 *     WEB's six status planes arrive as `null` when their try_lock was
 *     contended, with their names in `partial[]`; the rows must then say
 *     "busy", not "absent".
 *   * `continuation` — SERVER-side paging. The builder's own «Показать ещё»
 *     reveals rows already in memory (§10.5); a cursor-paged collection
 *     needs a second request once every loaded row is on screen, and only
 *     the page component can make it.
 *   * `actions`/`entityAction` — a bounded mutation offered beside the data
 *     it acts on (WEB's «Закрыть по фильтру» and «Закрыть сессию»). The
 *     confirmation step and the request belong to the page; the section
 *     only owns WHERE the control sits.
 *
 * Anything a definition CAN express stays in the definition.
 */
export interface SectionExtras {
  /** Short word shown beside the section title. */
  badge?: string;
  /** Server-side continuation, offered once every loaded row is on screen. */
  continuation?: {
    hasMore: boolean;
    pending: boolean;
    onLoad: () => void;
    label: string;
  };
  /** Actions at the head of the section body, in the order given. */
  actions?: readonly SectionAction[];
  /** Action at the foot of an open entity surface; receives the entity key. */
  entityAction?: {
    label: string;
    onSelect: (key: string) => void;
    danger?: boolean;
    disabled?: boolean;
  };
}

/**
 * What the section can honestly say about the rows an action would act on.
 *
 * The visible set is `filters ∧ search ∧ group`, and only the first third of
 * that is expressible as a server-side selector. Handing the page the
 * filters ALONE — which is what this contract used to do — let a page build
 * a request that closed a SUPERSET of what the reader was looking at: type
 * `alice` in the search box, pick one carrier, press the button, and every
 * session on that carrier goes, not the two on screen.
 *
 * So the section reports both halves: the declared filters, and the keys of
 * the rows that actually survived all three narrowings. `narrowed` is the
 * one bit a page needs to choose between them — when it is true the filters
 * do NOT describe the visible set and a key list is the only honest request.
 */
export interface SectionActionScope {
  /** The declared filters the reader currently has applied. */
  filters: Record<string, FilterValue>;
  /**
   * Stable keys (§5.3's semantic identity) of every row the section is
   * showing — the whole filtered set, not just the current paging window,
   * since «Показать ещё» reveals rows already in memory.
   */
  visibleKeys: string[];
  /** How many rows the section holds before any narrowing. */
  loadedCount: number;
  /** True when the search box or a group chip narrows beyond `filters`. */
  narrowed: boolean;
}

/** One control at the head of a section body. */
export interface SectionAction {
  label: string;
  onSelect: (scope: SectionActionScope) => void;
  danger?: boolean;
  disabled?: boolean;
  /** Sentence shown under the controls — why this one cannot be pressed. */
  note?: string;
  /**
   * Upper bound on `visibleKeys` for a NARROWED selection, i.e. the largest
   * key list the page's request can carry. Over it the control is disabled
   * and `tooManyNote` explains why, rather than the page silently widening
   * the request back to the filter it cannot express.
   */
  maxVisible?: number;
  tooManyNote?: (count: number, max: number) => string;
}

export interface DetailRenderContext {
  /** One clock for the whole page, so every age on screen is measured from the same instant. */
  nowMs: number;
  mode: DisplayMode;
  /** Field-catalog scope: which catalog, and which endpoint's rules win (R9). */
  lookup: FieldLookupContext;

  expandedSections: ReadonlySet<string>;
  toggleSection: (id: string) => void;
  expandedRecords: ReadonlySet<string>;
  toggleRecord: (id: string) => void;

  visibleLimit: (id: string, initial: number) => number;
  revealMore: (id: string, step: number, initial: number) => void;

  /**
   * Domain filters, by the key a FilterDefinition declares. Page state
   * rather than section state on purpose: §18.2's summary shortcut must be
   * able to write the very key the section's own control toggles, which is
   * what makes "рядом остаётся обычный filter control" true rather than a
   * second, parallel mechanism.
   */
  filters: Record<string, FilterValue>;
  setFilter: (key: string, value: FilterValue | undefined) => void;
  /** The ONE active sort, tagged with the section it belongs to (see SortState). */
  sort: SortState | undefined;
  setSort: (sort: SortState | undefined) => void;

  openSurfaceKey: string | undefined;
  openSurface: (key: string) => void;
  closeSurface: () => void;

  /** What a section's source state forces onto its rows, if anything. */
  absenceFor?: (sourceId: string | undefined) => ForcedAbsence | undefined;
  /** Live, section-scoped extensions supplied by the page — see SectionExtras. */
  extrasFor?: (sectionId: string) => SectionExtras | undefined;
}

// showsAtMode is THE display-mode filter for the whole builder — sections,
// scalar fields and summary metrics all go through this one call
// (06-ui.md: "одна функция, не if-ы по страницам"). `undefined` means the
// element declares no minimum and is always shown.
export function showsAtMode(minMode: DisplayMode | undefined, mode: DisplayMode): boolean {
  return minMode === undefined || visibleFor(minMode, mode);
}

// isSectionExpanded reads PageState.expandedSections as the set of sections
// whose expansion DIFFERS from their default, not as the set of open ones.
//
// The default is a property of the resolved instance (§10.5's size table
// decides it), while the state half is a plain Set seeded empty. Encoding
// "differs from default" keeps expansion a pure function of state — a
// section that should start open renders open on the FIRST render, with no
// seeding effect and no collapsed-then-expanded flash — and leaves the
// reducer's `toggleSection` meaning exactly what it says.
export function isSectionExpanded(
  id: string,
  defaultExpanded: boolean,
  expandedSections: ReadonlySet<string>,
): boolean {
  return expandedSections.has(id) !== defaultExpanded;
}

export interface RenderContextOptions {
  nowMs: number;
  mode: DisplayMode;
  lookup?: FieldLookupContext;
  absenceFor?: (sourceId: string | undefined) => ForcedAbsence | undefined;
  sectionExtras?: Record<string, SectionExtras>;
}

// createRenderContext adapts the page's state API to the renderer contract.
export function createRenderContext(
  api: DetailPageStateApi,
  options: RenderContextOptions,
): DetailRenderContext {
  return {
    nowMs: options.nowMs,
    mode: options.mode,
    lookup: options.lookup ?? {},
    expandedSections: api.state.expandedSections,
    toggleSection: api.toggleSection,
    expandedRecords: api.state.expandedRecords,
    toggleRecord: api.toggleRecord,
    visibleLimit: api.visibleLimit,
    revealMore: api.revealMore,
    filters: api.state.filters,
    setFilter: api.setFilter,
    sort: api.state.sort,
    setSort: api.setSort,
    openSurfaceKey: api.state.openSurfaceKey,
    openSurface: api.openSurface,
    closeSurface: api.closeSurface,
    ...(options.absenceFor ? { absenceFor: options.absenceFor } : {}),
    ...(options.sectionExtras
      ? { extrasFor: (sectionId: string) => options.sectionExtras?.[sectionId] }
      : {}),
  };
}
