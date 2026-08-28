// Page state for a Details page (spec §7.2, §19.1, ruling R3).
//
// The state is split in two on purpose:
//
//   * `selectedEntityKey` and `activeTab` live in the URL SEARCH PARAMS
//     (TanStack Router, validated) — they are what a deep link or a shared
//     URL has to reproduce: "look at DC -203, on the writers tab";
//   * search query, filters, sort, open accordions, open surface and
//     visible limits live in ROUTE MEMORY — a plain useReducer, so they
//     survive every realtime frame and a device rotation (the component
//     does not unmount) and are gone after navigating away, which is what
//     R3 asks for. No sessionStorage (spec §30.1–2).
//
// Neither half ever holds a copy of the payload (§7.2). That single fact is
// most of §19.1: a realtime frame replaces the payload and cannot close an
// accordion, change the tab, reset a filter or drop a visible limit,
// because none of those live anywhere the frame can reach. The tests below
// assert it by construction rather than by hoping.
//
// The one thing a new payload MAY invalidate is the selected entity: it can
// genuinely be gone from the next snapshot. §19.2 says that gets "понятное
// состояние и затем безопасный fallback selection" — never a crash and
// never a silent jump to some other entity — which is `selectEntity()`
// below: a pure function returning an explicit `gone` state carrying the
// fallback the UI may offer.

import { useCallback, useMemo, useReducer, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { FilterValue, PageState, SortState } from "./model";

// --- the URL half --------------------------------------------------------

export interface DetailSearch {
  entity?: string;
  tab?: string;
}

// Long enough for a fingerprint or an IPv6 endpoint, short enough that a
// crafted URL cannot push megabytes into the history entry.
const MAX_SEARCH_VALUE = 256;

function searchString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > MAX_SEARCH_VALUE ? trimmed.slice(0, MAX_SEARCH_VALUE) : trimmed;
}

// validateDetailSearch is the route's `validateSearch`. It is total: any
// junk in the URL degrades to "no selection" rather than throwing, because
// a hand-edited or stale link must still open the page (spec §14: never an
// empty screen).
export function validateDetailSearch(search: Record<string, unknown>): DetailSearch {
  const entity = searchString(search["entity"]);
  const tab = searchString(search["tab"]);
  return {
    ...(entity !== undefined ? { entity } : {}),
    ...(tab !== undefined ? { tab } : {}),
  };
}

// --- entity selection (§19.2) -------------------------------------------

export type EntitySelection =
  | { status: "none"; key: null; fallback: string | null }
  | { status: "selected"; key: string; fallback: string | null }
  | { status: "gone"; key: string; fallback: string | null };

// selectEntity resolves a URL-provided key against the keys the CURRENT
// payload carries. It never throws and never silently substitutes: a key
// that vanished produces `gone` plus the fallback the page may offer, so
// the reader learns their DC disappeared instead of quietly reading another
// one's numbers.
export function selectEntity(
  keys: readonly string[],
  selected: string | undefined,
): EntitySelection {
  const fallback = keys.length > 0 ? keys[0] : null;
  if (selected === undefined) return { status: "none", key: null, fallback };
  if (keys.includes(selected)) return { status: "selected", key: selected, fallback };
  return { status: "gone", key: selected, fallback };
}

// --- the in-memory half --------------------------------------------------

/** Everything PageState holds that is NOT in the URL. */
export type MemoryState = Omit<PageState, "selectedEntityKey" | "activeTab">;

export const EMPTY_MEMORY_STATE: MemoryState = {
  searchQuery: "",
  filters: {},
  expandedSections: new Set<string>(),
  expandedRecords: new Set<string>(),
  visibleLimits: {},
};

export type DetailPageAction =
  | { type: "setSearchQuery"; value: string }
  | { type: "setFilter"; key: string; value: FilterValue | undefined }
  | { type: "clearFilters" }
  | { type: "setSort"; sort: SortState | undefined }
  | { type: "setSectionExpanded"; id: string; expanded: boolean }
  | { type: "toggleSection"; id: string }
  | { type: "setRecordExpanded"; id: string; expanded: boolean }
  | { type: "toggleRecord"; id: string }
  | { type: "setVisibleLimit"; id: string; limit: number }
  | { type: "revealMore"; id: string; step: number; initial: number }
  | { type: "openSurface"; key: string }
  | { type: "closeSurface" }
  | { type: "reset"; initial?: Partial<MemoryState> };

function withToggled(set: ReadonlySet<string>, id: string, expanded: boolean): ReadonlySet<string> {
  if (set.has(id) === expanded) return set;
  const next = new Set(set);
  if (expanded) next.add(id);
  else next.delete(id);
  return next;
}

// detailPageReducer — pure, and deliberately identity-preserving: an action
// that would not change anything returns the SAME state object. §19.1
// forbids re-creating rows just because an object reference changed, and a
// reducer that reallocates on every no-op dispatch is the easiest way to
// violate that from below.
export function detailPageReducer(state: MemoryState, action: DetailPageAction): MemoryState {
  switch (action.type) {
    case "setSearchQuery":
      return state.searchQuery === action.value ? state : { ...state, searchQuery: action.value };
    case "setFilter": {
      const current = state.filters[action.key];
      if (action.value === undefined) {
        if (!(action.key in state.filters)) return state;
        const filters = { ...state.filters };
        delete filters[action.key];
        return { ...state, filters };
      }
      if (current === action.value) return state;
      return { ...state, filters: { ...state.filters, [action.key]: action.value } };
    }
    case "clearFilters":
      return Object.keys(state.filters).length === 0 ? state : { ...state, filters: {} };
    case "setSort":
      if (state.sort === action.sort) return state;
      if (
        state.sort &&
        action.sort &&
        state.sort.key === action.sort.key &&
        state.sort.direction === action.sort.direction
      ) {
        return state;
      }
      if (action.sort === undefined) {
        if (state.sort === undefined) return state;
        const next = { ...state };
        delete next.sort;
        return next;
      }
      return { ...state, sort: action.sort };
    case "setSectionExpanded":
    case "toggleSection": {
      const expanded =
        action.type === "toggleSection"
          ? !state.expandedSections.has(action.id)
          : action.expanded;
      const set = withToggled(state.expandedSections, action.id, expanded);
      return set === state.expandedSections ? state : { ...state, expandedSections: set };
    }
    case "setRecordExpanded":
    case "toggleRecord": {
      const expanded =
        action.type === "toggleRecord" ? !state.expandedRecords.has(action.id) : action.expanded;
      const set = withToggled(state.expandedRecords, action.id, expanded);
      return set === state.expandedRecords ? state : { ...state, expandedRecords: set };
    }
    case "setVisibleLimit":
      if (state.visibleLimits[action.id] === action.limit) return state;
      return { ...state, visibleLimits: { ...state.visibleLimits, [action.id]: action.limit } };
    case "revealMore": {
      // §18.3: progressive reveal. A limit only ever grows here; a realtime
      // frame with a longer array must not shrink what is already on screen.
      const current = state.visibleLimits[action.id] ?? action.initial;
      const limit = current + action.step;
      return { ...state, visibleLimits: { ...state.visibleLimits, [action.id]: limit } };
    }
    case "openSurface":
      return state.openSurfaceKey === action.key ? state : { ...state, openSurfaceKey: action.key };
    case "closeSurface": {
      if (state.openSurfaceKey === undefined) return state;
      const next = { ...state };
      delete next.openSurfaceKey;
      return next;
    }
    case "reset":
      return initialMemoryState(action.initial);
  }
}

export function initialMemoryState(initial?: Partial<MemoryState>): MemoryState {
  return {
    ...EMPTY_MEMORY_STATE,
    ...(initial ?? {}),
    // Sets are copied so an `initialState` shared by a module-level page
    // definition can never be mutated by one mounted page.
    expandedSections: new Set(initial?.expandedSections ?? []),
    expandedRecords: new Set(initial?.expandedRecords ?? []),
    filters: { ...(initial?.filters ?? {}) },
    visibleLimits: { ...(initial?.visibleLimits ?? {}) },
  };
}

// --- the hook ------------------------------------------------------------

export interface DetailPageStateApi {
  /** The merged §7.2 view: URL half + memory half. */
  state: PageState;
  dispatch: (action: DetailPageAction) => void;
  /** Writes the URL half. `replace` by default: browsing entities is not history. */
  selectEntityKey: (key: string | undefined) => void;
  setActiveTab: (tab: string | undefined) => void;
  /** Convenience wrappers over dispatch, stable across renders. */
  setSearchQuery: (value: string) => void;
  setFilter: (key: string, value: FilterValue | undefined) => void;
  toggleSection: (id: string) => void;
  toggleRecord: (id: string) => void;
  revealMore: (id: string, step: number, initial: number) => void;
  openSurface: (key: string) => void;
  closeSurface: () => void;
  visibleLimit: (id: string, initial: number) => number;
}

export interface UseDetailPageStateOptions {
  /** Page definition id. Changing it resets the in-memory half. */
  pageId: string;
  initial?: Partial<MemoryState>;
}

// useDetailSearch is the whole of the router coupling: `strict: false` so a
// single implementation serves every Details route without each one
// re-declaring the hook against its own route id.
export function useDetailSearch(): [DetailSearch, (next: DetailSearch) => void] {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const search = useMemo(() => validateDetailSearch(raw), [raw]);
  const setSearch = useCallback(
    (next: DetailSearch) => {
      // The cast is the price of being route-agnostic on purpose: this hook
      // serves EVERY Details route, so the search shape cannot be narrowed
      // to one generated route's union the way a per-route useNavigate()
      // call would. Omitting `to` keeps the current route; the reducer form
      // preserves any other search param the route owns, and an `undefined`
      // value clears its key from the URL.
      const go = navigate as unknown as (opts: {
        search: (prev: Record<string, unknown>) => Record<string, unknown>;
        replace?: boolean;
      }) => Promise<void>;
      void go({
        search: (prev) => ({ ...prev, ...next }),
        // Picking an entity or a tab is a view change, not a navigation
        // step: `replace` keeps the browser Back button meaning "leave this
        // page" instead of "undo my last click".
        replace: true,
      });
    },
    [navigate],
  );
  return [search, setSearch];
}

export function useDetailPageState(options: UseDetailPageStateOptions): DetailPageStateApi {
  const [search, setSearch] = useDetailSearch();
  const [memory, dispatch] = useReducer(detailPageReducer, options.initial, initialMemoryState);

  // Resetting on a pageId change rather than keying the component: the
  // Details route is one component for many pages, and R3 says the memory
  // half does not survive navigating to a different page. React's own
  // "adjust state during render" pattern — cheaper than an effect, which
  // would render the new page once with the old page's filters.
  const [lastPageId, setLastPageId] = useState(options.pageId);
  if (lastPageId !== options.pageId) {
    setLastPageId(options.pageId);
    dispatch({ type: "reset", ...(options.initial ? { initial: options.initial } : {}) });
  }

  const selectEntityKey = useCallback(
    (key: string | undefined) => setSearch({ entity: key }),
    [setSearch],
  );
  const setActiveTab = useCallback((tab: string | undefined) => setSearch({ tab }), [setSearch]);
  const setSearchQuery = useCallback((value: string) => dispatch({ type: "setSearchQuery", value }), []);
  const setFilter = useCallback(
    (key: string, value: FilterValue | undefined) => dispatch({ type: "setFilter", key, value }),
    [],
  );
  const toggleSection = useCallback((id: string) => dispatch({ type: "toggleSection", id }), []);
  const toggleRecord = useCallback((id: string) => dispatch({ type: "toggleRecord", id }), []);
  const revealMore = useCallback(
    (id: string, step: number, initial: number) =>
      dispatch({ type: "revealMore", id, step, initial }),
    [],
  );
  const openSurface = useCallback((key: string) => dispatch({ type: "openSurface", key }), []);
  const closeSurface = useCallback(() => dispatch({ type: "closeSurface" }), []);

  const state = useMemo<PageState>(
    () => ({
      ...memory,
      ...(search.entity !== undefined ? { selectedEntityKey: search.entity } : {}),
      ...(search.tab !== undefined ? { activeTab: search.tab } : {}),
    }),
    [memory, search.entity, search.tab],
  );

  const visibleLimit = useCallback(
    (id: string, initial: number) => memory.visibleLimits[id] ?? initial,
    [memory.visibleLimits],
  );

  return {
    state,
    dispatch,
    selectEntityKey,
    setActiveTab,
    setSearchQuery,
    setFilter,
    toggleSection,
    toggleRecord,
    revealMore,
    openSurface,
    closeSurface,
    visibleLimit,
  };
}
