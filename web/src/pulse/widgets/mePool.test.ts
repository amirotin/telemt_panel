import { describe, expect, it } from "vitest";
import { computeMePoolView } from "./mePool.helpers";
import type { RuntimeMePoolState, RuntimeMeQuality } from "../../realtime/topics";

function pool(overrides: Partial<RuntimeMePoolState["writers"]> = {}): RuntimeMePoolState {
  return {
    generations: { active_generation: 1, warm_generation: 1, pending_hardswap_generation: 0, pending_hardswap_age_secs: null, draining_generations: [] },
    hardswap: { enabled: true, pending: false },
    writers: { total: 10, alive_non_draining: 8, draining: 2, degraded: 0, contour: { warm: 1, active: 8, draining: 2 }, health: { healthy: 8, degraded: 0, draining: 2 }, ...overrides },
    refill: { inflight_endpoints_total: 0, inflight_dc_total: 0, by_dc: [] },
  };
}

const quality: RuntimeMeQuality = {
  counters: { idle_close_by_peer_total: 0, reader_eof_total: 0, kdf_drift_total: 0, kdf_port_only_drift_total: 0, reconnect_attempt_total: 5, reconnect_success_total: 4 },
  route_drops: { no_conn_total: 0, channel_closed_total: 0, queue_full_total: 0, queue_full_base_total: 0, queue_full_high_total: 0 },
  family_states: [],
  drain_gate: { route_quorum_ok: true, redundancy_ok: true, block_reason: "", updated_at_epoch_secs: 0 },
  dc_rtt: [],
};

describe("computeMePoolView", () => {
  it("reads writer/hardswap figures from the pool payload alone", () => {
    expect(computeMePoolView(pool())).toEqual({
      writersTotal: 10,
      writersAlive: 8,
      writersDraining: 2,
      hardswapPending: false,
      reconnectAttemptTotal: undefined,
      reconnectSuccessTotal: undefined,
    });
  });

  it("adds reconnect counters when quality is also available", () => {
    const view = computeMePoolView(pool(), quality);
    expect(view.reconnectAttemptTotal).toBe(5);
    expect(view.reconnectSuccessTotal).toBe(4);
  });

  it("reflects hardswap.pending", () => {
    const p = pool();
    p.hardswap.pending = true;
    expect(computeMePoolView(p).hardswapPending).toBe(true);
  });
});
