import type { DcStatus } from "../../realtime/topics";

export type DcResult =
  | { status: "loading" }
  | { status: "disabled"; reason?: string }
  | { status: "ok"; dcs: DcStatus[] };

// computeDc reads the "upstreams" topic's dcs field (GET /v1/stats/dcs,
// gated behind minimal_runtime_enabled — DcStatusData is always present
// once the topic loads, but its own middle_proxy_enabled flag reports
// whether the underlying feature is on).
export function computeDc(
  dcs: { middle_proxy_enabled: boolean; reason?: string; dcs: DcStatus[] } | null,
): DcResult {
  if (!dcs) return { status: "loading" };
  if (!dcs.middle_proxy_enabled) return { status: "disabled", reason: dcs.reason };
  return { status: "ok", dcs: dcs.dcs };
}

// dcCoverageState maps a DC's coverage_pct to the StatePill semantic set —
// full coverage is ok, any shortfall relative to the floor is a problem
// worth flagging (warn under 100%, error at 0 alive writers).
export function dcCoverageState(dc: DcStatus): "ok" | "warn" | "error" {
  if (dc.alive_writers === 0) return "error";
  if (dc.coverage_pct < 100) return "warn";
  return "ok";
}
