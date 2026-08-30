import { describe, expect, it } from "vitest";
import {
  TIMELINE_LIMIT,
  coalesceEvents,
  coalescedLine,
  computeRecentEventsView,
  eventAgo,
  eventCategory,
  eventLine,
  eventPhraseKey,
  eventRepeatText,
  eventTime,
  eventTone,
} from "./recentEvents.helpers";
import { events as eventsFixture } from "../details-builder/__fixtures__";
import type { RuntimeEdgeEventRecord, RuntimeEdgeEvents } from "../../realtime/topics";
import { en, ru } from "../../i18n";

// Distinct types by default, so the coalescer has nothing to fold and the
// view's ordering/limit can be checked on its own.
function events(count: number): RuntimeEdgeEvents {
  return {
    capacity: 50,
    dropped_total: 0,
    events: Array.from({ length: count }, (_, i) => ({
      seq: i + 1,
      ts_epoch_secs: 1_788_000_000 + i,
      event_type: `api.thing${i}.ok`,
      context: `generation=${i}`,
    })),
  };
}

function record(over: Partial<RuntimeEdgeEventRecord> & { seq: number }): RuntimeEdgeEventRecord {
  return {
    ts_epoch_secs: 1_788_000_000 + over.seq,
    event_type: "admission.state",
    context: "accepting_new_connections=true",
    ...over,
  };
}

describe("computeRecentEventsView", () => {
  it("puts the newest event first", () => {
    const view = computeRecentEventsView(events(3));
    expect(view.rows.map((r) => r.latest.seq)).toEqual([3, 2, 1]);
  });

  it("shows five rows by default — concept §15's timeline", () => {
    expect(TIMELINE_LIMIT).toBe(5);
    expect(computeRecentEventsView(events(50)).rows).toHaveLength(5);
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

  it("fills five rows out of a ring that repeats one fact", () => {
    // Fifty admission flips plus four other events: without coalescing the
    // whole feed is admission, five rows deep.
    const flips = Array.from({ length: 46 }, (_, i) =>
      record({ seq: i + 5, context: `accepting_new_connections=${i % 2 === 0}` }),
    );
    const others = [
      record({ seq: 1, event_type: "config.reload.applied", context: "" }),
      record({ seq: 2, event_type: "api.user.create.ok", context: "username=a" }),
      record({ seq: 3, event_type: "config.reload.failed", context: "bad toml" }),
      record({ seq: 4, event_type: "api.user.delete.ok", context: "username=b" }),
    ];
    const view = computeRecentEventsView({
      capacity: 50,
      dropped_total: 0,
      events: [...others, ...flips],
    });
    expect(view.rows).toHaveLength(5);
    expect(view.rows[0]!.count).toBe(46);
    expect(view.rows.slice(1).map((r) => r.latest.event_type)).toEqual([
      "api.user.delete.ok",
      "config.reload.failed",
      "api.user.create.ok",
      "config.reload.applied",
    ]);
  });
});

describe("coalesceEvents", () => {
  it("leaves distinct events alone", () => {
    const rows = coalesceEvents([
      record({ seq: 3, event_type: "config.reload.applied" }),
      record({ seq: 2, event_type: "api.user.create.ok" }),
      record({ seq: 1, event_type: "admission.state" }),
    ]);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1]);
  });

  it("collapses a run and keeps both of its ends", () => {
    const rows = coalesceEvents([record({ seq: 3 }), record({ seq: 2 }), record({ seq: 1 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
    expect(rows[0]!.latest.seq).toBe(3);
    expect(rows[0]!.oldest.seq).toBe(1);
  });

  it("only collapses CONSECUTIVE events — a reload between two flips splits them", () => {
    const rows = coalesceEvents([
      record({ seq: 4 }),
      record({ seq: 3, event_type: "config.reload.applied" }),
      record({ seq: 2 }),
      record({ seq: 1 }),
    ]);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 2]);
  });

  it("keeps a success and a failure of the same operation apart", () => {
    const rows = coalesceEvents([
      record({ seq: 2, event_type: "config.reload.failed" }),
      record({ seq: 1, event_type: "config.reload.applied" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("counts the whole run even past the row limit", () => {
    const run = Array.from({ length: 12 }, (_, i) => record({ seq: 12 - i }));
    const rows = coalesceEvents([...run, record({ seq: 0, event_type: "config.reload.applied" })], 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(12);
  });
});

describe("coalescedLine", () => {
  it("states the transition when a run's two ends are opposite states", () => {
    const rows = coalesceEvents([
      record({ seq: 3, context: "accepting_new_connections=true" }),
      record({ seq: 2, context: "accepting_new_connections=false" }),
      record({ seq: 1, context: "accepting_new_connections=false" }),
    ]);
    expect(coalescedLine(rows[0]!, ru).text).toBe("Приём клиентов: закрыт → открыт");
    expect(coalescedLine(rows[0]!, en).text).toBe("Client admission: closed → open");
  });

  it("keeps the newest sentence when both ends say the same thing", () => {
    const rows = coalesceEvents([
      record({ seq: 2, context: "accepting_new_connections=true" }),
      record({ seq: 1, context: "accepting_new_connections=true" }),
    ]);
    expect(coalescedLine(rows[0]!, ru).text).toBe(ru.pulse.recentEvents.types.admissionOpen);
  });

  it("has no transition to state for a type with no opposite", () => {
    const rows = coalesceEvents([
      record({ seq: 2, event_type: "config.reload.applied", context: "" }),
      record({ seq: 1, event_type: "config.reload.applied", context: "" }),
    ]);
    expect(coalescedLine(rows[0]!, ru).text).toBe(ru.pulse.recentEvents.types.configReloaded);
  });

  it("prints an uncollapsed row exactly as eventLine does", () => {
    const one = record({ seq: 1, event_type: "api.user.create.ok", context: "username=user_15" });
    expect(coalescedLine({ latest: one, oldest: one, count: 1 }, ru)).toEqual(eventLine(one, ru));
  });
});

describe("eventRepeatText", () => {
  it("says nothing for a row that collapsed nothing", () => {
    const one = record({ seq: 1 });
    expect(eventRepeatText({ latest: one, oldest: one, count: 1 }, ru)).toBeNull();
  });

  it("counts the run and spans it", () => {
    const row = {
      latest: record({ seq: 3, ts_epoch_secs: 1_788_007_200 }),
      oldest: record({ seq: 1, ts_epoch_secs: 1_788_000_000 }),
      count: 3,
    };
    expect(eventRepeatText(row, ru)).toBe("×3 за 2 ч.");
    expect(eventRepeatText(row, en)).toBe("×3 in 2 hours");
  });

  it("does not invent a span for a burst inside one minute", () => {
    const row = {
      latest: record({ seq: 3, ts_epoch_secs: 1_788_000_010 }),
      oldest: record({ seq: 1, ts_epoch_secs: 1_788_000_000 }),
      count: 3,
    };
    expect(eventRepeatText(row, ru)).toBe(`×3 ${ru.pulse.recentEvents.spanShort}`);
  });
});

describe("eventAgo", () => {
  const at = 1_788_000_000;

  it("says «только что» inside the first minute", () => {
    expect(eventAgo(at, at * 1000 + 30_000, ru)).toBe(ru.pulse.recentEvents.justNow);
  });

  it("counts back in one coarse unit", () => {
    expect(eventAgo(at, at * 1000 + 12 * 60_000, ru)).toBe("12 мин. назад");
    expect(eventAgo(at, at * 1000 + 3 * 3_600_000, en)).toBe("3 hours ago");
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
