import type { RuntimeUpstreamQualityData, UpstreamStatus } from "../../realtime/topics";

export type UpstreamsResult =
  | { status: "loading" }
  | { status: "disabled"; reason?: string }
  | { status: "ok"; upstreams: UpstreamStatus[]; healthyTotal: number; unhealthyTotal: number };

// computeUpstreams reads the "upstreams" topic's own upstreams field
// (GET /v1/stats/upstreams) — like DcStatusData, always present once the
// topic loads with its own enabled/reason flag for the underlying feature.
export function computeUpstreams(
  data: { enabled: boolean; reason?: string; summary?: { healthy_total: number; unhealthy_total: number }; upstreams?: UpstreamStatus[] } | null,
): UpstreamsResult {
  if (!data) return { status: "loading" };
  if (!data.enabled) return { status: "disabled", reason: data.reason };
  const upstreams = data.upstreams ?? [];
  return {
    status: "ok",
    upstreams,
    healthyTotal: data.summary?.healthy_total ?? upstreams.filter((u) => u.healthy).length,
    unhealthyTotal: data.summary?.unhealthy_total ?? upstreams.filter((u) => !u.healthy).length,
  };
}

// upstreamQualitySuccessRate computes the compact success-rate figure the
// widget shows in extended mode (0-100, rounded) — null when the
// upstream_quality payload is off/absent or has never attempted a connect
// (division by zero), so the caller can omit the line entirely rather than
// showing a misleading 0%.
export function upstreamQualitySuccessRate(quality: RuntimeUpstreamQualityData | null | undefined): number | null {
  if (!quality?.enabled) return null;
  const { connect_attempt_total, connect_success_total } = quality.counters;
  if (connect_attempt_total === 0) return null;
  return Math.round((connect_success_total / connect_attempt_total) * 100);
}
