import { describe, expect, it } from "vitest";
import {
  TIMELINE_LIMIT,
  computeRecentEventsView,
  eventCategory,
  eventTime,
  eventTone,
} from "./recentEvents.helpers";
import type { RuntimeEdgeEvents } from "../../realtime/topics";
import { en, ru } from "../../i18n";

function events(count: number): RuntimeEdgeEvents {
  return {
    capacity: 50,
    dropped_total: 0,
    events: Array.from({ length: count }, (_, i) => ({
      seq: i + 1,
      ts_epoch_secs: 1_788_000_000 + i,
      event_type: "admission.state",
      context: `generation=${i}`,
    })),
  };
}

describe("computeRecentEventsView", () => {
  it("puts the newest event first", () => {
    const view = computeRecentEventsView(events(3));
    expect(view.events.map((e) => e.seq)).toEqual([3, 2, 1]);
  });

  it("shows five rows by default — concept §15's timeline", () => {
    expect(TIMELINE_LIMIT).toBe(5);
    expect(computeRecentEventsView(events(50)).events).toHaveLength(5);
  });

  it("does not reorder the payload in place", () => {
    const payload = events(3);
    computeRecentEventsView(payload);
    expect(payload.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("carries the dropped counter through", () => {
    const payload = { ...events(1), dropped_total: 7 };
    expect(computeRecentEventsView(payload).droppedTotal).toBe(7);
  });
});

// Concept §15's icon table: ↻ reload · ◎ listener · ⇄ routing · ♙ user ·
// ⚠ warning · ✕ error, and a neutral dot for anything this catalog has
// never seen.
describe("eventCategory", () => {
  it("maps the two types the live proxies actually emit", () => {
    expect(eventCategory("admission.state")).toBe("listener");
    expect(eventCategory("config.reload.applied")).toBe("reload");
  });

  it("reads the outcome before the subject", () => {
    expect(eventCategory("config.reload.failed")).toBe("error");
    expect(eventCategory("me.route.timeout")).toBe("warning");
  });

  it("maps routing, user and listener families", () => {
    expect(eventCategory("route.switch")).toBe("routing");
    expect(eventCategory("upstream.reconnect")).toBe("routing");
    expect(eventCategory("api.user.create.ok")).toBe("user");
    expect(eventCategory("web.listener.bound")).toBe("listener");
  });

  it("is neutral for a type this catalog has never seen", () => {
    expect(eventCategory("something.entirely.new")).toBe("neutral");
    expect(eventCategory("")).toBe("neutral");
  });

  it("does not care about case", () => {
    expect(eventCategory("CONFIG.RELOAD.APPLIED")).toBe("reload");
  });
});

describe("eventTone", () => {
  it("colours only warning, error and success", () => {
    expect(eventTone("config.reload.failed")).toBe("error");
    expect(eventTone("me.route.timeout")).toBe("warn");
    expect(eventTone("config.reload.applied")).toBe("ok");
    expect(eventTone("api.user.create.ok")).toBe("ok");
  });

  it("leaves everything else neutral", () => {
    expect(eventTone("admission.state")).toBe("neutral");
    expect(eventTone("route.switch")).toBe("neutral");
  });

  it("is independent of the icon category", () => {
    // A failed reload is drawn with the error glyph AND the error tone; a
    // successful one keeps the reload glyph but goes green.
    expect(eventCategory("config.reload.applied")).toBe("reload");
    expect(eventTone("config.reload.applied")).toBe("ok");
  });
});

describe("eventTime", () => {
  it("is a 24-hour HH:MM stamp in both languages", () => {
    // 2026-08-30 18:43:07 UTC — the exact hour depends on the runner's
    // zone, so the SHAPE is what is asserted, plus the two locales
    // agreeing (an English «6:43 PM» would break the rail's alignment).
    const stamp = eventTime(1_788_072_187, ru);
    expect(stamp).toMatch(/^\d{2}:\d{2}$/);
    expect(eventTime(1_788_072_187, en)).toBe(stamp);
  });
});
