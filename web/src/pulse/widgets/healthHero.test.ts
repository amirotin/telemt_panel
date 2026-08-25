import { describe, expect, it } from "vitest";
import { computeHealthHero } from "./healthHero.helpers";
import type { StatsSnapshot } from "../../realtime/topics";
import { ru as s } from "../../i18n";

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { health: null, summary: null, ready: null, ...overrides };
}

describe("computeHealthHero", () => {
  it("returns null when the topic hasn't loaded yet", () => {
    expect(computeHealthHero(null, s)).toBeNull();
  });

  it("is ok/ready with no reason when everything is healthy and ready", () => {
    const view = computeHealthHero(
      stats({ health: { status: "ok", read_only: false }, ready: { ready: true, status: "ready", admission_open: true, healthy_upstreams: 2, total_upstreams: 2 } }),
      s,
    );
    expect(view).toEqual({ pillState: "ok", label: "Работает", ready: true, readyReason: undefined, readOnly: false });
  });

  it("carries the ready reason and read_only flag when not ready and read-only", () => {
    const view = computeHealthHero(
      stats({
        health: { status: "degraded", read_only: true },
        ready: { ready: false, status: "not_ready", reason: "no healthy upstreams", admission_open: false, healthy_upstreams: 0, total_upstreams: 2 },
      }),
      s,
    );
    expect(view).toEqual({ pillState: "error", label: "Деградация", ready: false, readyReason: "no healthy upstreams", readOnly: true });
  });

  it("reports ready:null when the ready sub-call never came back", () => {
    const view = computeHealthHero(stats({ health: { status: "ok", read_only: false } }), s);
    expect(view?.ready).toBeNull();
  });
});
