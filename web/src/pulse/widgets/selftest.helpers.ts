import type { RuntimeMeSelftest } from "../../realtime/topics";

export interface SelftestView {
  kdfState: string;
  timeskewState: string;
  maxSkewSecs15m: number | null;
  pidState: string;
}

export function computeSelftestView(selftest: RuntimeMeSelftest): SelftestView {
  return {
    kdfState: selftest.kdf.state,
    timeskewState: selftest.timeskew.state,
    maxSkewSecs15m: selftest.timeskew.max_skew_secs_15m,
    pidState: selftest.pid.state,
  };
}

// selftestPillState maps a self-test sub-state string to the shared
// StatePill semantics. Telemt's own vocabulary (ok/warn/degraded/error/
// unknown, per runtime_selftest.rs) isn't fully known ahead of time, so
// this stays a small heuristic rather than an exhaustive switch — matches
// StatusStrip.helpers.ts's healthPillState's own "anything else is an
// error" fallback.
export function selftestPillState(state: string): "ok" | "warn" | "error" | "muted" {
  if (state === "ok") return "ok";
  if (state === "warn" || state === "degraded") return "warn";
  if (!state) return "muted";
  return "error";
}
