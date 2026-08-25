import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, WIDGETS, getWidgetDef } from "./registry";
import { ru } from "../../i18n";

const KNOWN_TOPICS = new Set(["users", "stats", "runtime", "upstreams", "security", "update"]);

describe("WIDGETS registry invariants", () => {
  it("has unique widget ids", () => {
    const ids = WIDGETS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts health_hero first", () => {
    expect(WIDGETS[0].id).toBe("health_hero");
  });

  it("makes health_hero the only non-hideable widget", () => {
    const nonHideable = WIDGETS.filter((w) => !w.hideable).map((w) => w.id);
    expect(nonHideable).toEqual(["health_hero"]);
  });

  it("gives every widget a non-empty Russian title from ru.pulse.widgets", () => {
    for (const w of WIDGETS) {
      expect(w.title).toBe(ru.pulse.widgets[w.id]);
      expect(w.title.length).toBeGreaterThan(0);
    }
  });

  it("only declares topics from the known topic set", () => {
    for (const w of WIDGETS) {
      expect(w.topics.length).toBeGreaterThan(0);
      for (const t of w.topics) {
        expect(KNOWN_TOPICS.has(t)).toBe(true);
      }
    }
  });

  it("declares a valid formFactor for every widget", () => {
    const valid = new Set(["stat", "card", "wide", "table"]);
    for (const w of WIDGETS) {
      expect(valid.has(w.formFactor)).toBe(true);
    }
  });

  it("declares a valid minMode for every widget", () => {
    const valid = new Set(["critical", "basic", "extended"]);
    for (const w of WIDGETS) {
      expect(valid.has(w.minMode)).toBe(true);
    }
  });
});

describe("DEFAULT_LAYOUT", () => {
  it("only references ids that exist in the registry", () => {
    for (const id of DEFAULT_LAYOUT) {
      expect(getWidgetDef(id)).toBeDefined();
    }
  });

  it("starts with health_hero", () => {
    expect(DEFAULT_LAYOUT[0]).toBe("health_hero");
  });

  it("includes every non-hideable widget", () => {
    const nonHideableIds = WIDGETS.filter((w) => !w.hideable).map((w) => w.id);
    for (const id of nonHideableIds) {
      expect(DEFAULT_LAYOUT).toContain(id);
    }
  });
});

describe("getWidgetDef", () => {
  it("returns the matching definition", () => {
    expect(getWidgetDef("health_hero")?.id).toBe("health_hero");
  });

  it("returns undefined for an id not in the registry", () => {
    // @ts-expect-error deliberately an invalid id to exercise the not-found path
    expect(getWidgetDef("nonexistent")).toBeUndefined();
  });
});
