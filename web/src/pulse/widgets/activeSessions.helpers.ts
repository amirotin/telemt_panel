import type { StatsSnapshot } from "../../realtime/topics";

export type ActiveSessionsResult =
  | { status: "loading" }
  | { status: "gated"; reason?: string }
  | { status: "ok"; current: number; viaMe: number; direct: number; activeUsers: number };

// computeActiveSessions reads stats.connections_summary — the field is
// entirely absent from the wire (not an explicit closed Gated[T]) when the
// runtime_edge capability itself is off (hub.go's fetchStats only calls
// ConnectionsSummary when Capabilities().RuntimeEdge is true), so an absent
// field and an explicit enabled:false both mean "gated off" here; only the
// reason text differs (absent → no reason, the caller falls back to the
// runtime_edge hint).
export function computeActiveSessions(stats: StatsSnapshot | null): ActiveSessionsResult {
  if (!stats) return { status: "loading" };
  const gated = stats.connections_summary;
  if (!gated || !gated.enabled || !gated.data) {
    return { status: "gated", reason: gated?.reason };
  }
  const t = gated.data.totals;
  return {
    status: "ok",
    current: t.current_connections,
    viaMe: t.current_connections_me,
    direct: t.current_connections_direct,
    activeUsers: t.active_users,
  };
}
