import { describe, expect, it } from "vitest";
import { WEB_REASON_UNSUPPORTED, computeWebCard } from "./web.helpers";
import type { Gated, WebRuntimeStatus, WebStatus } from "../../realtime/topics";
import { en, ru } from "../../i18n";

function runtime(overrides: Partial<WebRuntimeStatus> = {}): WebRuntimeStatus {
  return {
    runtime_instance: "r1",
    generation_id: 1,
    limits: {},
    manager: {
      issuance_enabled: true,
      issuance_generation: 1,
      shutdown: false,
      bootstraps: 0,
      sessions: 3,
      closed_tokens: 0,
      closed_sessions: 0,
      client_ips: 2,
      profiles: 1,
    },
    streams: null,
    budget: null,
    websockets: null,
    learning: null,
    debug: null,
    permits: [],
    auxiliary_tasks: 0,
    session_incarnations_created: 0,
    session_incarnations_closed: 0,
    streams_opened: 0,
    streams_rejected: 0,
    bytes_up: 0,
    bytes_down: 0,
    limit_hits: 0,
    partial: [],
    ...overrides,
  };
}

function status(overrides: Partial<WebStatus> = {}): Gated<WebStatus> {
  const data: WebStatus = {
    lifecycle: "running",
    lifecycle_epoch: 2,
    lifecycle_age_ms: 900,
    available: true,
    listeners: ["0.0.0.0:443"],
    effective_config_enabled: true,
    runtime: runtime(),
    ...overrides,
  };
  return { enabled: data.available, data, ...(data.reason ? { reason: data.reason } : {}) };
}

// Concept §11's states, plus the two a real fleet adds to them.
describe("computeWebCard", () => {
  it("reads a running listener as «Работает», with what it can count", () => {
    const view = computeWebCard(status());
    expect(view).toMatchObject({
      state: "running",
      tone: "ok",
      compact: false,
      listeners: ["0.0.0.0:443"],
      sessions: 3,
      limitHits: 0,
    });
  });

  it("says «Запускается» while the runtime is coming up", () => {
    const view = computeWebCard(status({ lifecycle: "starting", available: false }));
    expect(view.state).toBe("starting");
    expect(view.tone).toBe("warn");
    // Not compact: a starting runtime already has listeners worth naming.
    expect(view.compact).toBe(false);
    expect(view.reason).toBe("starting");
  });

  it("folds the three going-away lifecycles into «Дренаж»", () => {
    for (const lifecycle of ["draining", "drained", "deadline_exceeded"]) {
      const view = computeWebCard(status({ lifecycle, available: false }));
      expect(view.state).toBe("draining");
      expect(view.tone).toBe("warn");
      // §17: a degraded card says why, in Telemt's own word.
      expect(view.reason).toBe(lifecycle);
    }
  });

  it("is a compact «Выключен» when no listener was configured", () => {
    const view = computeWebCard(
      status({
        lifecycle: "no_web_listener",
        available: false,
        reason: "no_web_listener",
        listeners: [],
        effective_config_enabled: false,
        runtime: null,
      }),
    );
    expect(view).toMatchObject({ state: "disabled", tone: "muted", compact: true });
    expect(view.reason).toBe("no_web_listener");
  });

  it("is «Выключен» when the effective config has WEB off, whatever the lifecycle says", () => {
    expect(
      computeWebCard(status({ effective_config_enabled: false, available: false })).state,
    ).toBe("disabled");
  });

  // The state this VPS is actually in: Telemt 3.4.25 has no
  // /v1/runtime/web/* route, and hub.go marks the gate with its own token.
  it("reports a build without the route as «Нет в этой версии», compactly", () => {
    const view = computeWebCard({ enabled: false, reason: WEB_REASON_UNSUPPORTED });
    expect(view).toMatchObject({ state: "unsupported", tone: "muted", compact: true });
    expect(ru.pulse.web.state.unsupported).toBe("Нет в этой версии");
    expect(en.pulse.web.state.unsupported).toBe("Not in this version");
  });

  it("does not confuse a missing poll with a missing route", () => {
    expect(computeWebCard(null).state).toBe("unavailable");
    expect(computeWebCard(undefined).state).toBe("unavailable");
    const closed = computeWebCard({ enabled: false, reason: "web_runtime_unavailable" });
    expect(closed.state).toBe("unavailable");
    expect(closed.reason).toBe("web_runtime_unavailable");
  });

  it("keeps a contended manager plane apart from zero sessions", () => {
    const view = computeWebCard(status({ runtime: runtime({ manager: null }) }));
    expect(view.sessions).toBeNull();
    expect(computeWebCard(status()).sessions).toBe(3);
  });

  it("prints the lifecycle verbatim when it is one this catalog never saw", () => {
    const view = computeWebCard(status({ lifecycle: "quiescing", available: false }));
    expect(view.state).toBe("unavailable");
    expect(view.reason).toBe("quiescing");
  });

  it("names a state for every case, and each has a word in both dictionaries", () => {
    for (const state of [
      "running",
      "starting",
      "draining",
      "disabled",
      "unsupported",
      "unavailable",
    ] as const) {
      expect(ru.pulse.web.state[state].length).toBeGreaterThan(0);
      expect(en.pulse.web.state[state].length).toBeGreaterThan(0);
    }
  });
});
