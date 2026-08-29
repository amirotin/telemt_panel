import { describe, expect, it } from "vitest";
import { computeHealthHero, readyReasonText, telemtUpdateVersion } from "./healthHero.helpers";
import type { StatsSnapshot } from "../../realtime/topics";
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

describe("computeHealthHero", () => {
  it("returns null when the topic hasn't loaded yet", () => {
    expect(computeHealthHero(null, s)).toBeNull();
  });

  it("is one ok word with no reason when the proxy is healthy and serving", () => {
    const view = computeHealthHero(
      stats({ health: { status: "ok", read_only: false }, ready: ready() }),
      s,
    );
    expect(view?.tone).toBe("ok");
    expect(view?.label).toBe("Работает");
    expect(view?.reason).toBeUndefined();
  });

  // Readiness overrides health: a proxy whose /v1/health says "ok" while it
  // refuses every client is not «Работает».
  it("says «Не принимает клиентов» with the translated reason when not ready", () => {
    const view = computeHealthHero(
      stats({
        health: { status: "ok", read_only: false },
        ready: ready({ ready: false, status: "not_ready", reason: "no_healthy_upstreams", healthy_upstreams: 0 }),
      }),
      s,
    );
    expect(view?.label).toBe("Не принимает клиентов");
    expect(view?.tone).toBe("error");
    expect(view?.reason).toBe(s.pulse.health.readyReason.noHealthyUpstreams);
  });

  // A drained proxy is an operator's own doing — a warning, not a failure.
  it("tones a closed admission gate as warn, not error", () => {
    const view = computeHealthHero(
      stats({
        health: { status: "ok", read_only: false },
        ready: ready({ ready: false, status: "not_ready", reason: "admission_closed", admission_open: false }),
      }),
      s,
    );
    expect(view?.tone).toBe("warn");
    expect(view?.reason).toBe(s.pulse.health.readyReason.admissionClosed);
  });

  it("falls back to the health status when the ready sub-call never came back", () => {
    const view = computeHealthHero(stats({ health: { status: "degraded", read_only: true } }), s);
    expect(view?.label).toBe("Деградация");
    expect(view?.tone).toBe("error");
    expect(view?.reason).toBeUndefined();
  });
});

describe("computeHealthHero facts", () => {
  it("names uptime, the Telemt version and the last config reload", () => {
    const view = computeHealthHero(
      stats({ health: { status: "ok", read_only: false }, version: "3.5.5", uptime_seconds: 3 * 86_400 }),
      s,
    );
    expect(view?.facts.map((f) => f.key)).toEqual(["uptime", "version", "configReload"]);
    expect(view?.facts[0].value).toBe("3 дн.");
    expect(view?.facts[1].value).toBe("3.5.5");
  });

  it("prefers the reload timestamp over the count", () => {
    const now = 1_800_000_000_000;
    const view = computeHealthHero(
      stats({ config_reload_count: 4, last_config_reload_epoch_secs: now / 1000 - 7200 }),
      s,
      now,
    );
    expect(view?.facts[2].value).toBe("2 ч. назад");
  });

  it("falls back to the reload count when Telemt sends no timestamp", () => {
    const view = computeHealthHero(stats({ config_reload_count: 2 }), s);
    expect(view?.facts[2].value).toBe("2 раза");
  });

  it("says «не было» when nothing has been reloaded", () => {
    expect(computeHealthHero(stats(), s)?.facts[2].value).toBe("не было");
  });

  it("shows an em dash for a version the stats topic has not carried yet", () => {
    expect(computeHealthHero(stats(), s)?.facts[1].value).toBe("—");
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
        { target: "panel", current_version: "1.0.0", releases: [{ version: "9.9.9", published_at: "2026-08-01T00:00:00Z", newer: true }] },
      ],
    };
  }

  it("returns the newest release marked newer for the Telemt target", () => {
    expect(telemtUpdateVersion(updates([{ version: "3.5.5", newer: true }, { version: "3.5.4" }]))).toBe("3.5.5");
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
