import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, STACK_SIZE, WIDGETS, getWidgetDef } from "./registry";
import { ru } from "../../i18n";
import { visibleFor } from "../../display-mode";

const KNOWN_TOPICS = new Set(["users", "stats", "runtime", "upstreams", "security", "update"]);

const SPAN: Record<string, number> = {
  third: 4,
  fiveTwelfths: 5,
  half: 6,
  sevenTwelfths: 7,
  twoThirds: 8,
  full: 12,
  tiles: 12,
};

/** The board plus the stack beside it — concept §13's row, in columns. */
const SPAN_CLASSES_TOTAL = SPAN[getWidgetDef("dc")!.size]! + SPAN[STACK_SIZE.infra]!;

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
      expect(ru.pulse.widgets[w.id]).toBeTruthy();
      expect(ru.pulse.widgets[w.id].length).toBeGreaterThan(0);
    }
  });

  it("only declares topics from the known topic set", () => {
    for (const w of WIDGETS) {
      // `topics` is optional: a REST-backed widget (tls_fingerprints, which
      // fetches on its own cadence since M4 task 1) declares none. When it
      // IS declared it must be non-empty and name real topics — an empty
      // array would be a widget claiming to be SSE-backed by nothing.
      if (w.topics === undefined) continue;
      expect(w.topics.length).toBeGreaterThan(0);
      for (const t of w.topics) {
        expect(KNOWN_TOPICS.has(t)).toBe(true);
      }
    }
  });

  it("declares topics for every widget except the REST-backed one", () => {
    const withoutTopics = WIDGETS.filter((w) => w.topics === undefined).map((w) => w.id);
    expect(withoutTopics).toEqual(["tls_fingerprints"]);
  });

  it("declares a valid grid size for every widget", () => {
    const valid = new Set([
      "third",
      "fiveTwelfths",
      "half",
      "sevenTwelfths",
      "twoThirds",
      "full",
      "tiles",
    ]);
    for (const w of WIDGETS) {
      expect(valid.has(w.size)).toBe(true);
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

// Concept §14: these four left Сводка's catalog. Re-adding one is a product
// decision, not a refactor, so the catalog says so out loud.
describe("Сводка's catalog after concept §14", () => {
  it("offers no Безопасность, Активные сессии, NAT/STUN or Аптайм card", () => {
    const ids = WIDGETS.map((w) => String(w.id));
    for (const gone of ["security_posture", "active_sessions", "nat_stun", "uptime"]) {
      expect(ids).not.toContain(gone);
    }
  });

  it("pairs Проблемы and Онлайн into one twelve-column row", () => {
    expect(getWidgetDef("problems")!.size).toBe("fiveTwelfths");
    expect(getWidgetDef("online_now")!.size).toBe("sevenTwelfths");
  });
});

// Concept §20's desktop order, which DEFAULT_LAYOUT reproduces top to
// bottom: status banner, KPI tiles, Проблемы beside Онлайн, the data-center
// board, the infrastructure row, the event timeline.
describe("DEFAULT_LAYOUT follows concept §20's page order", () => {
  it("is exactly the concept's list, in the concept's order", () => {
    expect(DEFAULT_LAYOUT).toEqual([
      "health_hero",
      "stat_row",
      "problems",
      "online_now",
      "dc",
      "me_pool",
      "recent_events",
    ]);
  });

  it("closes the page with the event timeline, at half width", () => {
    expect(DEFAULT_LAYOUT.at(-1)).toBe("recent_events");
    expect(getWidgetDef("recent_events")!.size).toBe("half");
  });

  // Eight columns for the board, four for the stack beside it — one row.
  it("gives the data-center board eight of the twelve columns", () => {
    expect(getWidgetDef("dc")!.size).toBe("twoThirds");
    expect(SPAN_CLASSES_TOTAL).toBe(12);
  });

  // Concept §13: ME, WEB and Апстримы are the infrastructure level, and
  // they STACK in the four columns beside the board rather than forming a
  // row under it. WEB arrives in S4 and joins the same stack.
  it("puts the infrastructure cards in one stacked column", () => {
    expect(getWidgetDef("me_pool")!.stack).toBe("infra");
    expect(getWidgetDef("upstreams")!.stack).toBe("infra");
    expect(STACK_SIZE.infra).toBe("third");
  });

  it("puts ME straight after the data-center board, where the stack starts", () => {
    expect(DEFAULT_LAYOUT.indexOf("me_pool")).toBe(DEFAULT_LAYOUT.indexOf("dc") + 1);
  });

  it("only stacks widgets that also declare a span for the stack to use", () => {
    for (const w of WIDGETS) {
      if (w.stack === undefined) continue;
      expect(w.size).toBe(STACK_SIZE[w.stack]);
    }
  });

  it("shows every default widget in the default display mode", () => {
    for (const id of DEFAULT_LAYOUT) {
      expect(visibleFor(getWidgetDef(id)!.minMode, "basic")).toBe(true);
    }
  });
});
