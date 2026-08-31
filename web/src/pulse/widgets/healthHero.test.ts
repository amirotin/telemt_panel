import { describe, expect, it } from "vitest";
import {
  computeHealthHero,
  readyReasonText,
  routeModeValue,
  telemtUpdateVersion,
  type HealthHeroInput,
} from "./healthHero.helpers";
import type { RuntimeGates, RuntimeTopic, StatsSnapshot } from "../../realtime/topics";
import type { UpdatesStatus } from "../../lib/api/generated/types.gen";
import { ru as s } from "../../i18n";

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { health: null, summary: null, ready: null, ...overrides };
}

function ready(overrides: Partial<NonNullable<StatsSnapshot["ready"]>> = {}) {
  return {
    ready: true,
    status: "ready",
    admission_open: true,
    healthy_upstreams: 2,
    total_upstreams: 2,
    ...overrides,
  };
}

function gates(overrides: Partial<RuntimeGates> = {}): RuntimeGates {
  return {
    accepting_new_connections: true,
    conditional_cast_enabled: false,
    me_runtime_ready: true,
    me2dc_fallback_enabled: false,
    me2dc_fast_enabled: false,
    use_middle_proxy: true,
    route_mode: "middle",
    reroute_active: false,
    startup_status: "ready",
    startup_stage: "done",
    startup_progress_pct: 100,
    ...overrides,
  };
}

function runtime(overrides: Partial<RuntimeTopic> = {}): RuntimeTopic {
  return {
    gates: gates(),
    initialization: null,
    me_pool_state: null,
    me_quality: null,
    nat_stun: null,
    me_selftest: null,
    minimal: null,
    upstream_quality: null,
    ...overrides,
  };
}

function input(overrides: Partial<HealthHeroInput> = {}): HealthHeroInput {
  return { stats: stats(), runtime: runtime(), unreachable: false, ...overrides };
}

describe("computeHealthHero states", () => {
  it("returns null when neither the topic nor an error has arrived", () => {
    expect(computeHealthHero({ stats: null, runtime: null, unreachable: false }, s)).toBeNull();
  });

  it("is «Работает» when the proxy is healthy and serving", () => {
    const view = computeHealthHero(
      input({ stats: stats({ health: { status: "ok", read_only: false }, ready: ready() }) }),
      s,
    );
    expect(view?.tone).toBe("ok");
    expect(view?.label).toBe("Работает");
    expect(view?.reason).toBeUndefined();
  });

  // Telemt is not answering at all — the worst state, and the one the old
  // banner rendered as a cheerful green «Работает» off the last snapshot.
  it("is «Нет связи» when the stats topic reports a source error", () => {
    const view = computeHealthHero(
      input({
        unreachable: true,
        stats: stats({ health: { status: "ok", read_only: false }, ready: ready() }),
      }),
      s,
    );
    expect(view?.label).toBe("Нет связи");
    expect(view?.tone).toBe("error");
  });

  it("is «Запускается» while the runtime is still initializing", () => {
    const view = computeHealthHero(
      input({
        stats: stats({ health: { status: "ok", read_only: false }, ready: ready({ ready: false, reason: "admission_closed" }) }),
        runtime: runtime({ gates: gates({ startup_status: "initializing" }) }),
      }),
      s,
    );
    expect(view?.label).toBe("Запускается");
    expect(view?.tone).toBe("warn");
  });

  // Readiness overrides health: a proxy whose /v1/health says "ok" while it
  // refuses every client is not «Работает».
  it("is «Деградация» with the translated reason when not ready", () => {
    const view = computeHealthHero(
      input({
        stats: stats({
          health: { status: "ok", read_only: false },
          ready: ready({ ready: false, status: "not_ready", reason: "no_healthy_upstreams", healthy_upstreams: 0 }),
        }),
      }),
      s,
    );
    expect(view?.label).toBe("Деградация");
    expect(view?.tone).toBe("error");
    expect(view?.reason).toBe(s.pulse.health.readyReason.noHealthyUpstreams);
  });

  // A drained proxy is an operator's own doing — a warning, not a failure.
  it("tones a closed admission gate as warn, not error", () => {
    const view = computeHealthHero(
      input({
        stats: stats({
          health: { status: "ok", read_only: false },
          ready: ready({ ready: false, status: "not_ready", reason: "admission_closed", admission_open: false }),
        }),
      }),
      s,
    );
    expect(view?.tone).toBe("warn");
    expect(view?.reason).toBe(s.pulse.health.readyReason.admissionClosed);
  });

  it("is «Деградация» for a degraded health with no readiness answer", () => {
    const view = computeHealthHero(
      input({ stats: stats({ health: { status: "degraded", read_only: true } }) }),
      s,
    );
    expect(view?.label).toBe("Деградация");
    expect(view?.tone).toBe("warn");
  });

  it("aggregates a supporting subsystem degradation without adding banner facts", () => {
    const view = computeHealthHero(
      input({
        degraded: true,
        stats: stats({ health: { status: "ok", read_only: false }, ready: ready() }),
      }),
      s,
    );
    expect(view?.label).toBe("Деградация");
    expect(view?.tone).toBe("warn");
    expect(view?.reason).toBeUndefined();
  });

  it("is «Нет данных» when no health has come back at all", () => {
    expect(computeHealthHero(input(), s)?.tone).toBe("muted");
    expect(computeHealthHero(input(), s)?.label).toBe("Нет данных");
  });
});

describe("computeHealthHero facts", () => {
  it("names uptime, the Telemt version and the route mode", () => {
    const view = computeHealthHero(
      input({
        stats: stats({ health: { status: "ok", read_only: false }, version: "3.5.5", uptime_seconds: 3 * 86_400 }),
      }),
      s,
    );
    expect(view?.facts.map((f) => f.key)).toEqual(["uptime", "version", "route"]);
    expect(view?.facts[0].value).toBe("3 дн.");
    expect(view?.facts[1].value).toBe("3.5.5");
    expect(view?.facts[2].value).toBe("ME");
  });

  it("shows an em dash for a version and a route the topics have not carried yet", () => {
    const view = computeHealthHero(input({ runtime: null }), s);
    expect(view?.facts[1].value).toBe("—");
    expect(view?.facts[2].value).toBe("—");
  });
});

describe("routeModeValue", () => {
  it("is Direct when middle-proxy is off", () => {
    expect(routeModeValue(gates({ use_middle_proxy: false }), s)).toBe("Direct");
  });

  // The case the config flag alone cannot tell you about: middle-proxy is
  // configured, but the relay is running direct.
  it("is the fallback when middle-proxy is on and the relay rerouted", () => {
    expect(routeModeValue(gates({ reroute_active: true, route_mode: "direct" }), s)).toBe(
      "ME → Direct",
    );
    expect(routeModeValue(gates({ route_mode: "direct" }), s)).toBe("ME → Direct");
  });

  it("is ME when middle-proxy is on and carrying the traffic", () => {
    expect(routeModeValue(gates(), s)).toBe("ME");
  });
});

describe("readyReasonText", () => {
  it("accepts the space-separated spelling of the same token", () => {
    expect(readyReasonText("no healthy upstreams", s)).toBe(
      s.pulse.health.readyReason.noHealthyUpstreams,
    );
  });

  // A token this build doesn't know is shown raw: an untranslated word the
  // operator can search for beats hiding it behind "no reason given".
  it("passes an unknown token through untranslated", () => {
    expect(readyReasonText("some_future_reason", s)).toBe("some_future_reason");
  });

  it("falls back to «Причина не указана» when there is no token at all", () => {
    expect(readyReasonText(undefined, s)).toBe(s.pulse.health.noReason);
  });
});

describe("telemtUpdateVersion", () => {
  function updates(releases: Array<{ version: string; newer?: boolean }>): UpdatesStatus {
    return {
      lock_held: false,
      targets: [
        {
          target: "telemt",
          current_version: "3.5.4",
          releases: releases.map((r) => ({ ...r, published_at: "2026-08-01T00:00:00Z" })),
        },
        {
          target: "panel",
          current_version: "1.0.0",
          releases: [{ version: "9.9.9", published_at: "2026-08-01T00:00:00Z", newer: true }],
        },
      ],
    };
  }

  it("returns the newest release marked newer for the Telemt target", () => {
    expect(
      telemtUpdateVersion(updates([{ version: "3.5.5", newer: true }, { version: "3.5.4" }])),
    ).toBe("3.5.5");
  });

  // The panel target having an update must not put a Telemt version on the
  // banner — the chip sits beside «Версия Telemt».
  it("returns null when only the panel has an update", () => {
    expect(telemtUpdateVersion(updates([{ version: "3.5.4" }]))).toBeNull();
  });

  it("returns null before the query has answered", () => {
    expect(telemtUpdateVersion(undefined)).toBeNull();
  });
});
