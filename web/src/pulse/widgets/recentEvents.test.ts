import { describe, expect, it } from "vitest";
import {
  TIMELINE_LIMIT,
  computeRecentEventsView,
  eventCategory,
  eventLine,
  eventPhraseKey,
  eventTime,
  eventTone,
} from "./recentEvents.helpers";
import { events as eventsFixture } from "../details-builder/__fixtures__";
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


// Concept §15 draws sentences, not `config.reload.applied`. The table is
// deliberately a table: an event type is a contract, and the only honest
// way to say "this means the configuration was reloaded" is to name the
// type that means it. Everything else stays verbatim.
describe("eventPhraseKey", () => {
  const cases: Array<[string, string, string | null]> = [
    // The two spellings of admission.state in the wild: the live proxies'
    // and the recorded snapshot the fixtures are built from.
    ["admission.state", "generation=1 accepting_new_connections=true", "admissionOpen"],
    ["admission.state", "generation=1 accepting_new_connections=false", "admissionClosed"],
    ["admission.state", "open (healthy_upstreams=1)", "admissionOpen"],
    ["admission.state", "closed (healthy_upstreams=0)", "admissionClosed"],
    ["admission.state", "something new", null],
    ["config.reload.applied", "generation 8 activated", "configReloaded"],
    ["config.reload.ok", "", "configReloaded"],
    ["config.apply.done", "", "configReloaded"],
    ["config.reload.failed", "bad toml", "configReloadFailed"],
    ["config.reload.error", "", "configReloadFailed"],
    ["process.restart", "", "restarted"],
    ["runtime.restarted", "", "restarted"],
    ["web.listener.started", ":443", "listenerStarted"],
    ["listener.bound", ":443", "listenerStarted"],
    ["web.listener.stopped", ":443", "listenerStopped"],
    ["listener.down", "", "listenerStopped"],
    ["me.route.fallback", "", "routeFallback"],
    ["reroute.direct", "no proxy config", "routeFallback"],
    ["me.route.restored", "", "routeRestored"],
    ["reroute.middle", "", "routeRestored"],
    ["api.user.create.ok", "username=user_15", "userCreated"],
    ["api.user.delete.ok", "username=user_15", "userDeleted"],
    ["api.user.disable.ok", "username=user_15", "userDisabled"],
    ["api.user.enable.ok", "username=user_15", "userEnabled"],
    // A FAILED operation must never borrow the success sentence.
    ["api.user.create.failed", "quota", null],
    ["something.entirely.new", "ctx", null],
    ["", "", null],
  ];

  it.each(cases)("%s / %s", (type, context, expected) => {
    expect(eventPhraseKey({ event_type: type, context })).toBe(expected);
  });

  it("does not care about case or padding", () => {
    expect(eventPhraseKey({ event_type: " CONFIG.RELOAD.APPLIED ", context: "" })).toBe("configReloaded");
  });
});

describe("eventLine", () => {
  const record = (event_type: string, context: string) => ({
    seq: 1,
    ts_epoch_secs: 1_788_000_000,
    event_type,
    context,
  });

  it("says the admission fact once — its context is what the sentence states", () => {
    const line = eventLine(record("admission.state", "generation=1 accepting_new_connections=true"), ru);
    expect(line.text).toBe(ru.pulse.recentEvents.types.admissionOpen);
    expect(line.detail).toBeUndefined();
  });

  it("keeps the context beside every other sentence — it holds the WHICH", () => {
    const line = eventLine(record("api.user.create.ok", "username=user_15"), ru);
    expect(line.text).toBe(ru.pulse.recentEvents.types.userCreated);
    expect(line.detail).toBe("username=user_15");
  });

  it("falls back to Telemt's own type and context for an unknown event", () => {
    const line = eventLine(record("something.entirely.new", "ctx=1"), ru);
    expect(line.text).toBe("something.entirely.new");
    expect(line.detail).toBe("ctx=1");
  });

  it("omits an empty context rather than printing a dangling separator", () => {
    expect(eventLine(record("something.entirely.new", "   "), ru).detail).toBeUndefined();
  });

  it("translates: no Russian sentence leaks into the English dictionary", () => {
    const r = eventLine(record("config.reload.applied", ""), ru);
    const e = eventLine(record("config.reload.applied", ""), en);
    expect(r.text).toBe("Конфигурация перезагружена");
    expect(e.text).toBe("Configuration reloaded");
  });
});

// The recorded API snapshot the fixtures reproduce: fifty records, three
// types. Every one of them must reach a sentence — that snapshot IS what a
// reader sees on a live proxy, and a timeline of fifty `admission.state`
// rows is what §15 replaced.
describe("the fifty recorded events", () => {
  it("phrases every record, in both languages", () => {
    expect(eventsFixture.events).toHaveLength(50);
    for (const event of eventsFixture.events) {
      expect(eventPhraseKey(event)).not.toBeNull();
      expect(eventLine(event, ru).text).not.toBe(event.event_type);
      expect(eventLine(event, en).text).not.toBe(event.event_type);
    }
  });

  it("covers the three types the snapshot carries", () => {
    const keys = new Set(eventsFixture.events.map((e) => eventPhraseKey(e)));
    expect(keys).toEqual(new Set(["admissionOpen", "configReloaded", "userCreated"]));
  });
});
