import type { RuntimeMePoolState, RuntimeMeQuality } from "../../realtime/topics";

export interface MePoolView {
  writersTotal: number;
  writersAlive: number;
  writersDraining: number;
  hardswapPending: boolean;
  reconnectAttemptTotal?: number;
  reconnectSuccessTotal?: number;
}

// computeMePoolView combines the ME pool-state and ME-quality Gated[T]
// payloads into one widget view (06-ui.md's catalog lists "ME pool/quality"
// as a single widget) — quality is optional since it's an independently
// gated payload: the pool-state figures still render even when quality is
// off/unavailable, just without the reconnect counters.
export function computeMePoolView(pool: RuntimeMePoolState, quality?: RuntimeMeQuality): MePoolView {
  return {
    writersTotal: pool.writers.total,
    writersAlive: pool.writers.alive_non_draining,
    writersDraining: pool.writers.draining,
    hardswapPending: pool.hardswap.pending,
    reconnectAttemptTotal: quality?.counters.reconnect_attempt_total,
    reconnectSuccessTotal: quality?.counters.reconnect_success_total,
  };
}
