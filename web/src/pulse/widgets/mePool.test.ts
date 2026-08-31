import { describe, expect, it } from "vitest";
import { computeMeCard, meQualitySummary, meReasonText } from "./mePool.helpers";
import type {
  RuntimeGates,
  RuntimeMePoolState,
  RuntimeMeQuality,
} from "../../realtime/topics";
import { en } from "../../i18n";

function pool(overrides: Partial<RuntimeMePoolState["writers"]> = {}): RuntimeMePoolState {
  return {
    generations: { active_generation: 1, warm_generation: 1, pending_hardswap_generation: 0, pending_hardswap_age_secs: null, draining_generations: [] },
    hardswap: { enabled: true, pending: false },
    writers: { total: 44, alive_non_draining: 44, draining: 0, degraded: 0, contour: { warm: 0, active: 44, draining: 0 }, health: { healthy: 44, degraded: 0, draining: 0 }, ...overrides },
    refill: { inflight_endpoints_total: 0, inflight_dc_total: 0, by_dc: [] },
  };
}

function quality(overrides: Partial<RuntimeMeQuality> = {}): RuntimeMeQuality {
  return {
    counters: { idle_close_by_peer_total: 0, reader_eof_total: 0, kdf_drift_total: 0, kdf_port_only_drift_total: 0, reconnect_attempt_total: 5, reconnect_success_total: 4 },
    route_drops: { no_conn_total: 0, channel_closed_total: 0, queue_full_total: 0, queue_full_base_total: 0, queue_full_high_total: 0 },
    family_states: [{ family: "v4", state: "healthy", state_since_epoch_secs: 0, fail_streak: 0, recover_success_streak: 0 }],
    drain_gate: { route_quorum_ok: true, redundancy_ok: true, block_reason: "open", updated_at_epoch_secs: 0 },
    dc_rtt: [
      { dc: 1, rtt_ema_ms: 30, alive_writers: 3, required_writers: 3, coverage_pct: 100 },
      { dc: 2, rtt_ema_ms: 46, alive_writers: 3, required_writers: 3, coverage_pct: 100 },
    ],
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

describe("meQualitySummary", () => {
  it("weighs coverage by required writers rather than averaging percentages", () => {
    const q = quality({
      dc_rtt: [
        { dc: 1, rtt_ema_ms: 30, alive_writers: 5, required_writers: 10, coverage_pct: 50 },
        { dc: 2, rtt_ema_ms: 30, alive_writers: 2, required_writers: 2, coverage_pct: 100 },
      ],
    });
    // 7 of 12, not the 75% a mean of 50 and 100 would give.
    expect(meQualitySummary(q).coveragePct).toBeCloseTo(58.333, 3);
  });

  it("means the RTT of the data centers that reported one", () => {
    expect(meQualitySummary(quality()).rttMs).toBe(38);
  });

  it("ignores data centers with no RTT reading", () => {
    const q = quality({
      dc_rtt: [
        { dc: 1, rtt_ema_ms: null, alive_writers: 3, required_writers: 3, coverage_pct: 100 },
        { dc: 2, rtt_ema_ms: 40, alive_writers: 3, required_writers: 3, coverage_pct: 100 },
      ],
    });
    expect(q.dc_rtt).toHaveLength(2);
    expect(meQualitySummary(q).rttMs).toBe(40);
  });

  it("has neither figure when ME quality is gated off", () => {
    expect(meQualitySummary(undefined)).toEqual({ coveragePct: null, rttMs: null });
  });
});

// Concept §10's card and §17's adaptive rule: healthy is compact, anything
// else earns exactly one reason line.
describe("computeMeCard", () => {
  it("is healthy and reasonless when the pool is whole", () => {
    const view = computeMeCard(pool(), quality(), gates());
    expect(view.state).toBe("healthy");
    expect(view.tone).toBe("ok");
    expect(view.reason).toBeNull();
    expect(view.writersAlive).toBe(44);
    expect(view.writersTotal).toBe(44);
    expect(view.coveragePct).toBe(100);
    expect(view.rttMs).toBe(38);
    expect(view.refillInflight).toBe(0);
    expect(view.draining).toBe(0);
  });

  it("is fallback when traffic has been rerouted around the middle proxy", () => {
    const view = computeMeCard(pool(), quality(), gates({ reroute_active: true, reroute_reason: "no proxy config" }));
    expect(view.state).toBe("fallback");
    expect(view.tone).toBe("error");
    expect(view.reason).toEqual({ kind: "fallback", detail: "no proxy config" });
  });

  it("is fallback when the route mode itself says direct", () => {
    expect(computeMeCard(pool(), quality(), gates({ route_mode: "direct" })).state).toBe("fallback");
  });

  it("is not fallback on an instance that never used the middle proxy", () => {
    const view = computeMeCard(pool(), quality(), gates({ use_middle_proxy: false, route_mode: "direct" }));
    expect(view.state).toBe("healthy");
  });

  it("degrades on a coverage shortfall before anything else", () => {
    const q = quality({
      dc_rtt: [{ dc: 1, rtt_ema_ms: 30, alive_writers: 2, required_writers: 4, coverage_pct: 50 }],
    });
    const view = computeMeCard(pool({ draining: 1 }), q, gates());
    expect(view.state).toBe("degraded");
    expect(view.tone).toBe("warn");
    expect(view.reason).toEqual({ kind: "coverage", pct: 50 });
  });

  it("names missing writers when coverage is still full", () => {
    const view = computeMeCard(pool({ total: 44, alive_non_draining: 41 }), quality(), gates());
    expect(view.reason).toEqual({ kind: "writersLost", missing: 3 });
  });

  it("falls through to draining, then degraded writers, then an unwell family", () => {
    expect(computeMeCard(pool({ total: 44, alive_non_draining: 44, draining: 2 }), quality(), gates()).reason).toEqual({
      kind: "draining",
      count: 2,
    });
    expect(computeMeCard(pool({ degraded: 1 }), quality(), gates()).reason).toEqual({
      kind: "degradedWriters",
      count: 1,
    });
    const unwell = quality({
      family_states: [
        { family: "v4", state: "healthy", state_since_epoch_secs: 0, fail_streak: 0, recover_success_streak: 0 },
        { family: "v6", state: "suppressed", state_since_epoch_secs: 0, fail_streak: 3, recover_success_streak: 0 },
      ],
    });
    expect(computeMeCard(pool(), unwell, gates()).reason).toEqual({
      kind: "family",
      family: "v6",
      state: "suppressed",
    });
  });

  it("still reports its writers with ME quality gated off", () => {
    const view = computeMeCard(pool(), undefined, gates());
    expect(view.state).toBe("healthy");
    expect(view.coveragePct).toBeNull();
    expect(view.rttMs).toBeNull();
    expect(view.writersTotal).toBe(44);
  });
});

describe("meReasonText", () => {
  it("puts the proxy's own reroute reason in brackets when it sent one", () => {
    expect(meReasonText({ kind: "fallback", detail: "no proxy config" }, en)).toBe(
      "Traffic is going direct, bypassing ME (no proxy config)",
    );
    expect(meReasonText({ kind: "fallback" }, en)).toBe("Traffic is going direct, bypassing ME");
  });

  it("renders every other reason with its number", () => {
    expect(meReasonText({ kind: "coverage", pct: 58.3 }, en)).toBe("Coverage 58 %");
    expect(meReasonText({ kind: "writersLost", missing: 3 }, en)).toBe("Routes below writer floor: 3");
    expect(meReasonText({ kind: "draining", count: 2 }, en)).toBe("Writers draining: 2");
    expect(meReasonText({ kind: "degradedWriters", count: 1 }, en)).toBe("Writers degraded: 1");
    expect(meReasonText({ kind: "family", family: "v6", state: "suppressed" }, en)).toBe(
      "Family v6: suppressed",
    );
  });
});

// The card is the top of a column of three (§13). Its geometry has to be
// constant, so every field it prints is present in every state — the
// adaptivity §17 asks for is in the WORDS, not in the height.
describe("the card's four standing facts", () => {
  it("carries refill, draining, degraded and fallback in the healthy state too", () => {
    const view = computeMeCard(pool(), quality(), gates());
    expect(view.reason).toBeNull();
    expect(view).toMatchObject({ refillInflight: 0, draining: 0, degraded: 0, fallback: false });
  });

  it("reports each of them from the pool it was given", () => {
    const view = computeMeCard(
      { ...pool({ draining: 2, degraded: 3, alive_non_draining: 44 }), refill: { inflight_endpoints_total: 5, inflight_dc_total: 2, by_dc: [] } },
      quality(),
      gates(),
    );
    expect(view).toMatchObject({ refillInflight: 5, draining: 2, degraded: 3 });
  });

  it("says fallback is on exactly when traffic is bypassing ME", () => {
    expect(computeMeCard(pool(), quality(), gates({ reroute_active: true })).fallback).toBe(true);
    expect(computeMeCard(pool(), quality(), gates({ route_mode: "direct" })).fallback).toBe(true);
    // Middle proxy switched off entirely is not a fallback — there is no
    // ME for the traffic to be bypassing.
    expect(
      computeMeCard(pool(), quality(), gates({ use_middle_proxy: false, route_mode: "direct" }))
        .fallback,
    ).toBe(false);
  });

  it("keeps degraded writers as a fact even while a worse reason wins the status line", () => {
    const view = computeMeCard(pool({ draining: 1, degraded: 4 }), quality(), gates());
    expect(view.reason).toEqual({ kind: "draining", count: 1 });
    expect(view.degraded).toBe(4);
    expect(view.draining).toBe(1);
  });
});
