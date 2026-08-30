import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultLayout,
  editorRows,
  getStoredLayout,
  hideWidget,
  migrateLayout,
  moveWidget,
  resetLayout,
  setStoredLayout,
  hiddenWidgetIds,
  showWidget,
  visibleWidgetIds,
  type Layout,
  overviewCells,
} from "./layout";
import { DEFAULT_LAYOUT, WIDGETS } from "./widgets/registry";

const STORAGE_KEY = "telemt-panel:pulse-layout:v1";

beforeEach(() => {
  localStorage.clear();
});

describe("defaultLayout", () => {
  it("matches the registry's DEFAULT_LAYOUT", () => {
    expect(defaultLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("returns a fresh array each time (callers can't mutate the source)", () => {
    const a = defaultLayout();
    a.push("dc");
    expect(defaultLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

describe("migrateLayout", () => {
  it("falls back to the default for a non-array value", () => {
    expect(migrateLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(migrateLayout("garbage")).toEqual(DEFAULT_LAYOUT);
    expect(migrateLayout({})).toEqual(DEFAULT_LAYOUT);
  });

  it("drops unknown ids (a widget removed from a later registry)", () => {
    expect(migrateLayout(["health_hero", "some_removed_widget", "dc"])).toEqual(["health_hero", "dc"]);
  });

  it("re-inserts a missing non-hideable id (health_hero) at the front", () => {
    expect(migrateLayout(["dc", "upstreams"])).toEqual(["health_hero", "dc", "upstreams"]);
  });

  it("does not duplicate health_hero when it's already present", () => {
    expect(migrateLayout(["health_hero", "dc"])).toEqual(["health_hero", "dc"]);
  });

  it("does not auto-add a hideable widget that was never in the stored layout", () => {
    const result = migrateLayout(["health_hero"]);
    expect(result).toEqual(["health_hero"]);
    expect(result).not.toContain("stat_row");
  });

  it("drops non-string entries", () => {
    expect(migrateLayout(["health_hero", 42, null])).toEqual(["health_hero"]);
  });
});

describe("getStoredLayout / setStoredLayout", () => {
  it("returns the default layout on first run (nothing stored)", () => {
    expect(getStoredLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("round-trips a stored layout through migration", () => {
    setStoredLayout(["health_hero", "dc", "upstreams"]);
    expect(getStoredLayout()).toEqual(["health_hero", "dc", "upstreams"]);
  });

  it("falls back to the default for garbage JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(getStoredLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("falls back to the default for a wrong-shaped stored value", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, ids: ["dc"] }));
    expect(getStoredLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("falls back to the default when localStorage.getItem throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getStoredLayout()).toEqual(DEFAULT_LAYOUT);
    spy.mockRestore();
  });

  it("does not throw when localStorage.setItem throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => setStoredLayout(["health_hero"])).not.toThrow();
    spy.mockRestore();
  });
});

describe("resetLayout", () => {
  it("restores and persists the default layout", () => {
    setStoredLayout(["health_hero", "dc"]);
    const result = resetLayout();
    expect(result).toEqual(DEFAULT_LAYOUT);
    expect(getStoredLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

describe("moveWidget", () => {
  const layout = ["health_hero", "stat_row", "problems"] as const;

  it("swaps with the previous entry on 'up'", () => {
    expect(moveWidget([...layout], "problems", "up")).toEqual(["health_hero", "problems", "stat_row"]);
  });

  it("swaps with the next entry on 'down'", () => {
    expect(moveWidget([...layout], "health_hero", "down")).toEqual(["stat_row", "health_hero", "problems"]);
  });

  it("is a no-op moving the first entry up", () => {
    expect(moveWidget([...layout], "health_hero", "up")).toEqual([...layout]);
  });

  it("is a no-op moving the last entry down", () => {
    expect(moveWidget([...layout], "problems", "down")).toEqual([...layout]);
  });

  it("is a no-op for an id not in the layout", () => {
    expect(moveWidget([...layout], "dc", "up")).toEqual([...layout]);
  });
});

describe("showWidget / hideWidget", () => {
  it("appends a widget not already present", () => {
    expect(showWidget(["health_hero"], "dc")).toEqual(["health_hero", "dc"]);
  });

  it("is a no-op showing an already-present widget", () => {
    expect(showWidget(["health_hero", "dc"], "dc")).toEqual(["health_hero", "dc"]);
  });

  it("removes a hideable widget", () => {
    expect(hideWidget(["health_hero", "dc"], "dc")).toEqual(["health_hero"]);
  });

  it("refuses to hide the non-hideable health_hero", () => {
    expect(hideWidget(["health_hero", "dc"], "health_hero")).toEqual(["health_hero", "dc"]);
  });
});

describe("visibleWidgetIds", () => {
  const layout: Layout = ["health_hero", "stat_row", "problems", "selftest"];

  it("keeps only widgets whose minMode is at or below the current mode", () => {
    expect(visibleWidgetIds(layout, "critical")).toEqual(["health_hero", "problems"]);
    expect(visibleWidgetIds(layout, "basic")).toEqual(["health_hero", "stat_row", "problems"]);
    expect(visibleWidgetIds(layout, "extended")).toEqual(layout);
  });

  it("drops an id the registry doesn't know", () => {
    // @ts-expect-error deliberately an unknown id
    expect(visibleWidgetIds(["health_hero", "nonexistent"], "extended")).toEqual(["health_hero"]);
  });

  it("preserves the layout's own order", () => {
    expect(visibleWidgetIds(["stat_row", "health_hero"], "basic")).toEqual(["stat_row", "health_hero"]);
  });
});

describe("editorRows", () => {
  const layout: Layout = ["health_hero", "problems", "selftest"];

  it("marks every row in the layout as shown, in the layout's own order first", () => {
    const rows = editorRows(layout, "extended");
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual(["health_hero", "problems", "selftest"]);
    expect(rows.slice(0, 3).every((r) => r.shown)).toBe(true);
  });

  it("appends every not-yet-shown widget, in registry order, marked shown:false", () => {
    const rows = editorRows(layout, "extended");
    const notShown = rows.slice(3);
    expect(notShown.every((r) => !r.shown)).toBe(true);
    expect(notShown[0].id).toBe("stat_row");
  });

  it("marks a shown widget unavailable when its minMode exceeds the current mode, without dropping it", () => {
    // selftest's minMode is "extended" — in critical mode it's still shown
    // (present in the layout) but not available.
    const rows = editorRows(layout, "critical");
    const selftest = rows.find((r) => r.id === "selftest");
    expect(selftest).toEqual({ id: "selftest", shown: true, availableInMode: false });
  });

  it("marks a shown widget available when its minMode is satisfied", () => {
    const rows = editorRows(layout, "critical");
    const healthHero = rows.find((r) => r.id === "health_hero");
    expect(healthHero).toEqual({ id: "health_hero", shown: true, availableInMode: true });
  });

  it("computes availableInMode for not-shown rows too", () => {
    const rows = editorRows(layout, "critical");
    const statRow = rows.find((r) => r.id === "stat_row"); // minMode: basic
    expect(statRow).toEqual({ id: "stat_row", shown: false, availableInMode: false });
  });

  it("returns exactly one row per registry widget, never duplicated", () => {
    const rows = editorRows(layout, "basic");
    expect(rows).toHaveLength(WIDGETS.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(WIDGETS.length);
  });
});

describe("hiddenWidgetIds", () => {
  it("lists registry widgets absent from the layout, in registry order", () => {
    const layout: Layout = ["health_hero", "problems"];
    const hidden = hiddenWidgetIds(layout, "extended");
    expect(hidden).not.toContain("health_hero");
    expect(hidden).not.toContain("problems");
    expect(hidden).toEqual(
      WIDGETS.filter((w) => w.id !== "health_hero" && w.id !== "problems").map((w) => w.id),
    );
  });

  it("omits a widget the display mode filters out — it is out of scope, not hidden", () => {
    // selftest's minMode is "extended": in basic mode «показать» could not
    // put it on screen, so the list must not offer it.
    expect(hiddenWidgetIds([], "basic")).not.toContain("selftest");
    expect(hiddenWidgetIds([], "extended")).toContain("selftest");
  });

  it("is empty when every available widget is already shown", () => {
    expect(hiddenWidgetIds(WIDGETS.map((w) => w.id), "extended")).toEqual([]);
  });

  it("is the exact complement of visibleWidgetIds within one mode", () => {
    const layout: Layout = ["health_hero", "stat_row", "online_now"];
    const shown = new Set(visibleWidgetIds(layout, "extended"));
    const hidden = new Set(hiddenWidgetIds(layout, "extended"));
    for (const id of shown) expect(hidden.has(id)).toBe(false);
    expect(shown.size + hidden.size).toBe(WIDGETS.length);
  });
});

afterEach(() => {
  localStorage.clear();
});

// A device that had one of concept §14's removed cards shown keeps working:
// migrateLayout drops the unknown id on the next load rather than rendering
// nothing for it or throwing.
describe("layouts stored before concept §14 removed four cards", () => {
  it("drops the ids the registry no longer knows and keeps the rest in order", () => {
    expect(
      migrateLayout(["health_hero", "security_posture", "stat_row", "nat_stun", "active_sessions"]),
    ).toEqual(["health_hero", "stat_row"]);
  });
});


// Concept §13: the infrastructure cards share the four columns beside the
// data-center board instead of each taking a cell of its own.
describe("overviewCells", () => {
  it("gives a widget with no stack a cell of its own", () => {
    expect(overviewCells(["health_hero", "stat_row"])).toEqual([
      { kind: "widget", id: "health_hero" },
      { kind: "widget", id: "stat_row" },
    ]);
  });

  it("collapses a run of stacked widgets into one column cell", () => {
    expect(overviewCells(["dc", "me_pool", "upstreams", "recent_events"])).toEqual([
      { kind: "widget", id: "dc" },
      { kind: "stack", stack: "infra", ids: ["me_pool", "upstreams"] },
      { kind: "widget", id: "recent_events" },
    ]);
  });

  it("keeps the reader's own order — two runs stay two columns", () => {
    expect(overviewCells(["me_pool", "dc", "upstreams"])).toEqual([
      { kind: "stack", stack: "infra", ids: ["me_pool"] },
      { kind: "widget", id: "dc" },
      { kind: "stack", stack: "infra", ids: ["upstreams"] },
    ]);
  });

  it("lays the default layout out as the concept's rows", () => {
    expect(overviewCells(defaultLayout())).toEqual([
      { kind: "widget", id: "health_hero" },
      { kind: "widget", id: "stat_row" },
      { kind: "widget", id: "problems" },
      { kind: "widget", id: "online_now" },
      { kind: "widget", id: "dc" },
      { kind: "stack", stack: "infra", ids: ["me_pool"] },
      { kind: "widget", id: "recent_events" },
    ]);
  });

  it("names every id exactly once, whatever the grouping", () => {
    const ids = defaultLayout();
    const flat = overviewCells(ids).flatMap((c) => (c.kind === "stack" ? c.ids : [c.id]));
    expect(flat).toEqual(ids);
  });

  it("is empty for an empty render list", () => {
    expect(overviewCells([])).toEqual([]);
  });
});
