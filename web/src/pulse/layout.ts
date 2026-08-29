import { visibleFor, type DisplayMode } from "../display-mode";
import { DEFAULT_LAYOUT, WIDGETS, getWidgetDef } from "./widgets/registry";
import type { WidgetId } from "./types";

// Layout is the user's ordered, per-device widget list (06-ui.md: "раскладка
// — per-device в localStorage"). A widget id's mere presence means "shown"
// (subject to the display-mode filter below) — there is no separate hidden
// flag, so "hide" is simply removing the id and "show" is re-adding it.
export type Layout = WidgetId[];

const STORAGE_KEY = "telemt-panel:pulse-layout:v1";

const KNOWN_IDS = new Set(WIDGETS.map((w) => w.id));
const NON_HIDEABLE_IDS = WIDGETS.filter((w) => !w.hideable).map((w) => w.id);

export function defaultLayout(): Layout {
  return [...DEFAULT_LAYOUT];
}

// migrateLayout is the store's invariant-preserving function, run on every
// load (06-ui.md: "миграция при изменении каталога"):
//   - any id the current registry no longer knows (a widget removed in a
//     later release) is dropped;
//   - any non-hideable id missing from the stored array (e.g. health_hero,
//     should a bug or a future registry change have ever dropped it) is
//     re-inserted at the front, in registry order;
//   - a hideable widget added to the registry after this user's first run
//     is deliberately NOT auto-added — the user opts in via "Настроить".
export function migrateLayout(stored: unknown): Layout {
  if (!Array.isArray(stored)) return defaultLayout();
  const known = stored.filter(
    (id): id is WidgetId => typeof id === "string" && KNOWN_IDS.has(id as WidgetId),
  );
  const missingNonHideable = NON_HIDEABLE_IDS.filter((id) => !known.includes(id));
  return [...missingNonHideable, ...known];
}

interface StoredLayoutV1 {
  version: 1;
  ids: string[];
}

function isStoredLayoutV1(v: unknown): v is StoredLayoutV1 {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return obj["version"] === 1 && Array.isArray(obj["ids"]);
}

// getStoredLayout reads localStorage, migrating whatever was stored. A
// missing/garbage/unparseable value (first run, private mode, a throwing
// localStorage) falls back to defaultLayout() — this is also what makes
// "first run" auto-populate the default set, per the brief.
export function getStoredLayout(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isStoredLayoutV1(parsed)) return migrateLayout(parsed.ids);
    }
  } catch {
    // localStorage unavailable or garbage JSON — fall back to the default.
  }
  return defaultLayout();
}

export function setStoredLayout(layout: Layout): void {
  try {
    const payload: StoredLayoutV1 = { version: 1, ids: layout };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort — see getStoredLayout.
  }
}

// resetLayout restores and persists the default layout, returning it — the
// one function both Пульс's own "Сбросить к умолчанию" button and the
// Настройки панели page (Task 8) call.
export function resetLayout(): Layout {
  const layout = defaultLayout();
  setStoredLayout(layout);
  return layout;
}

// visibleWidgetIds is the dashboard's actual render list: the user's layout,
// filtered by the current display mode (06-ui.md: "виджет виден, если он в
// раскладке И его minMode ≤ текущего режима" — filtering happens ONLY here,
// through visibleFor, never a hand-rolled per-widget if).
export function visibleWidgetIds(layout: Layout, mode: DisplayMode): WidgetId[] {
  return layout.filter((id) => {
    const def = getWidgetDef(id);
    return def !== undefined && visibleFor(def.minMode, mode);
  });
}

// hiddenWidgetIds is visibleWidgetIds' complement for the Сводка page's
// «Скрытые блоки» list: registry widgets absent from the layout, in registry
// order. A widget the DISPLAY MODE filters out is not in this list — it is
// not hidden, it is out of scope for the current density, and offering
// «показать» for it would leave the reader tapping a button that changes
// nothing on screen.
export function hiddenWidgetIds(layout: Layout, mode: DisplayMode): WidgetId[] {
  const shown = new Set(layout);
  return WIDGETS.filter((w) => !shown.has(w.id) && visibleFor(w.minMode, mode)).map((w) => w.id);
}

// moveWidget swaps a widget with its up/down neighbor in the stored order;
// a request past either end of the array is a no-op (nothing to swap with).
export function moveWidget(layout: Layout, id: WidgetId, direction: "up" | "down"): Layout {
  const index = layout.indexOf(id);
  if (index < 0) return layout;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= layout.length) return layout;
  const next = [...layout];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function showWidget(layout: Layout, id: WidgetId): Layout {
  if (layout.includes(id)) return layout;
  return [...layout, id];
}

// hideWidget removes a widget from the layout — a no-op for a non-hideable
// id (health_hero), so a stray call can never drop it.
export function hideWidget(layout: Layout, id: WidgetId): Layout {
  if (NON_HIDEABLE_IDS.includes(id)) return layout;
  return layout.filter((x) => x !== id);
}

export interface EditorRow {
  id: WidgetId;
  /** In the user's layout at all (checked in the catalog) — independent of availableInMode. */
  shown: boolean;
  /** def.minMode ≤ the current display mode — a shown-but-unavailable row must stay visible in the editor, greyed with a hint, never silently dropped (fix round 1, item 1). */
  availableInMode: boolean;
}

// editorRows is the "Настроить" catalog's pure row list: every widget in
// the layout (in the user's own order), followed by every registry widget
// not yet shown (in registry order) — so a widget in the layout but
// filtered out by the current display mode still appears (shown: true,
// availableInMode: false) instead of looking indistinguishable from one
// that was never added.
export function editorRows(layout: Layout, mode: DisplayMode): EditorRow[] {
  const shownSet = new Set(layout);
  const ordered = [...layout.filter((id) => KNOWN_IDS.has(id)), ...WIDGETS.filter((w) => !shownSet.has(w.id)).map((w) => w.id)];
  return ordered.map((id) => {
    const def = getWidgetDef(id);
    return { id, shown: shownSet.has(id), availableInMode: def !== undefined && visibleFor(def.minMode, mode) };
  });
}
