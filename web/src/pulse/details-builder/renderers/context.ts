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
  };
}
