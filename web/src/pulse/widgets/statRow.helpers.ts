import { formatDurationApprox } from "../../people/expiry";
import type { StatsSnapshot } from "../../realtime/topics";
import type { HistorySeries } from "../../lib/api/generated/types.gen";
import type { Dict } from "../../i18n";

export interface StatRowValues {
  connections: number | null;
  /** True when the figure is the cumulative-since-start proxy, not a live concurrent count (task-2-report.md's outstanding-concerns note). */
  connectionsApprox: boolean;
  activeUsers: number | null;
  activeUsersApprox: boolean;
  uptimeLabel: string;
}

// computeStatRowValues picks the best connections/active-users figures
// actually available (live runtime_edge totals when present, else the
// always-on summary's coarser proxies — same rule StatusStrip.helpers.ts's
// connectionsLabel uses, kept independent here since this widget also needs
// the active-users figure and the approx flag that StatusStrip doesn't).
export function computeStatRowValues(stats: StatsSnapshot | null, s: Dict): StatRowValues {
  const live = stats?.connections_summary?.enabled ? stats.connections_summary.data?.totals : undefined;
  const connections = live ? live.current_connections : (stats?.summary?.connections_total ?? null);
  const activeUsers = live ? live.active_users : (stats?.summary?.configured_users ?? null);
  const uptimeSeconds = stats?.uptime_seconds ?? stats?.summary?.uptime_seconds ?? null;
  return {
    connections,
    connectionsApprox: !live,
    activeUsers,
    activeUsersApprox: !live,
    uptimeLabel: uptimeSeconds === null ? "—" : formatDurationApprox(uptimeSeconds * 1000, s),
  };
}

export function sparklineValues(series: HistorySeries | undefined): number[] {
  return series?.points.map((p) => p.v) ?? [];
}

export function latestHistoryValue(series: HistorySeries | undefined): number | null {
  const points = series?.points;
  if (!points || points.length === 0) return null;
  return points[points.length - 1].v;
}

// peakHistoryValue — the highest point in a series, for the row's "пик за
// 15 мин — N" sub-line (the prototype's own secondary metric line). Only
// meaningful for instantaneous gauges: on a cumulative counter the maximum
// is simply the last point, so callers skip it there.
export function peakHistoryValue(series: HistorySeries | undefined): number | null {
  const points = series?.points;
  if (!points || points.length === 0) return null;
  return points.reduce((max, p) => (p.v > max ? p.v : max), points[0].v);
}
