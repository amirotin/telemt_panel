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

// historyWindowDelta turns a CUMULATIVE counter series into the amount it
// grew across the window /api/history returned (range=15m — ruling R3's RAM
// ring). The `traffic` metric is the sum of every user's total_octets at
// each poll (internal/hub/hub.go's usersTrafficTotal), i.e. a lifetime
// total: on a 20-day-old server its last point is ~256 GB, which is what the
// "Трафик (15 мин)" row used to show. The honest 15-min figure is
// newest − oldest.
//
// Returns null with fewer than two points: one point carries no delta, and
// showing the raw cumulative value there would be exactly the defect this
// replaces — «—» is the correct answer until a second point lands.
//
// Counter resets (Telemt restarted, a user removed) make newest < oldest.
// Rather than render a negative "traffic", the newest value is taken as the
// amount accumulated since the reset — a lower bound on the real window
// total, never a nonsense figure.
export function historyWindowDelta(series: HistorySeries | undefined): number | null {
  const points = series?.points;
  if (!points || points.length < 2) return null;
  const oldest = points[0].v;
  const newest = points[points.length - 1].v;
  return newest < oldest ? newest : newest - oldest;
}

// deltaSparklineValues plots the same counter as a RATE: one value per
// step, so the sparkline shows the shape of traffic over the window instead
// of the cumulative ramp (which on a lifetime counter is a near-flat line
// nudging upward, carrying no information). Same reset rule as
// historyWindowDelta; a series shorter than two points has no steps at all.
export function deltaSparklineValues(series: HistorySeries | undefined): number[] {
  const points = series?.points;
  if (!points || points.length < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].v;
    const cur = points[i].v;
    out.push(cur < prev ? cur : cur - prev);
  }
  return out;
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
