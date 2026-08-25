import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultLayout,
  getStoredLayout,
  hideWidget,
  migrateLayout,
  moveWidget,
  resetLayout,
  setStoredLayout,
  showWidget,
  visibleWidgetIds,
  type Layout,
} from "./layout";
import { DEFAULT_LAYOUT } from "./widgets/registry";

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
  const layout: Layout = ["health_hero", "stat_row", "problems", "me_pool"];

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

afterEach(() => {
  localStorage.clear();
});
