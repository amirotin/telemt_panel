import type { StatsSnapshot } from "../../realtime/topics";
import type { HistorySeries } from "../../lib/api/generated/types.gen";

export interface StatRowValues {
  connections: number | null;
  /** True when the figure is the cumulative-since-start proxy, not a live concurrent count (task-2-report.md's outstanding-concerns note). */
  connectionsApprox: boolean;
  activeUsers: number | null;
  activeUsersApprox: boolean;
}

// computeStatRowValues picks the best connections/active-users figures
// actually available (live runtime_edge totals when present, else the
// always-on summary's coarser proxies — same rule StatusStrip.helpers.ts's
// connectionsLabel uses, kept independent here since this widget also needs
// the active-users figure and the approx flag that StatusStrip doesn't).
export function computeStatRowValues(stats: StatsSnapshot | null): StatRowValues {
  const live = stats?.connections_summary?.enabled ? stats.connections_summary.data?.totals : undefined;
  const connections = live ? live.current_connections : (stats?.summary?.connections_total ?? null);
  const activeUsers = live ? live.active_users : (stats?.summary?.configured_users ?? null);
  return {
    connections,
    connectionsApprox: !live,
    activeUsers,
    activeUsersApprox: !live,
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

// lastHistoryValue — the newest point of a series, i.e. the lifetime figure
// a cumulative counter has reached. The traffic tile's caption pairs the
// window delta it displays with this, so the number the operator knows from
// the Соединения page is never more than a glance away.
export function lastHistoryValue(series: HistorySeries | undefined): number | null {
  const points = series?.points;
  if (!points || points.length === 0) return null;
  return points[points.length - 1].v;
}

export interface ConnectionQuality {
  /** Share of connection attempts that succeeded, 0-100. null when nothing tried in the window. */
  percent: number | null;
  /** Refusals inside the window — the caption, and what «Проблемы» explains the cause of. */
  refusals: number;
  /** Percentage points the quality moved across the window (newer half minus older half). Negative is a decline. */
  changePoints: number | null;
}

// connectionQuality answers the fourth tile's question — "do connections
// establish normally?" — from the two monotonic series the hub records
// (internal/hub/counters.go): refusals over attempts across the window
// /api/history returned. Both are counted by the same accumulator, so a
// Telemt restart moves them together and the ratio stays honest.
//
// `changePoints` compares the window's newer half against its older half.
// The store's RAM ring only ever holds ~15 minutes (ruling R3), so there is
// no PREVIOUS window to compare against; the two halves of this one are the
// only "is it getting worse" signal the data can actually support.
export function connectionQuality(
  attempts: HistorySeries | undefined,
  refusals: HistorySeries | undefined,
): ConnectionQuality {
  const attemptPoints = attempts?.points ?? [];
  const refusalPoints = refusals?.points ?? [];
  const windowRefusals = historyWindowDelta(refusals) ?? 0;
  const windowAttempts = historyWindowDelta(attempts);
  if (windowAttempts === null || windowAttempts <= 0) {
    return { percent: null, refusals: windowRefusals, changePoints: null };
  }

  const percent = 100 - (windowRefusals / windowAttempts) * 100;

  // Both halves need their own attempts to divide by; a half with none is
  // not a 0 % half, it is a half with no answer.
  const n = Math.min(attemptPoints.length, refusalPoints.length);
  if (n < 4) return { percent, refusals: windowRefusals, changePoints: null };
  const mid = Math.floor(n / 2);
  const half = (from: number, to: number): number | null => {
    const a = attemptPoints[to].v - attemptPoints[from].v;
    if (a <= 0) return null;
    const r = refusalPoints[to].v - refusalPoints[from].v;
    return 100 - (r / a) * 100;
  };
  const older = half(0, mid);
  const newer = half(mid, n - 1);
  return {
    percent,
    refusals: windowRefusals,
    changePoints: older === null || newer === null ? null : newer - older,
  };
}

// qualitySparklineValues plots the quality curve the tile paints behind its
// number: one point per step, each the share of that step's attempts that
// were not refused. Steps with no attempts carry the previous value forward
// rather than reading as 0 % — an idle five seconds is not an outage.
export function qualitySparklineValues(
  attempts: HistorySeries | undefined,
  refusals: HistorySeries | undefined,
): number[] {
  const a = attempts?.points ?? [];
  const r = refusals?.points ?? [];
  const n = Math.min(a.length, r.length);
  if (n < 2) return [];
  const out: number[] = [];
  let last = 100;
  for (let i = 1; i < n; i++) {
    const da = a[i].v - a[i - 1].v;
    const dr = r[i].v - r[i - 1].v;
    if (da > 0 && dr >= 0) last = 100 - (dr / da) * 100;
    out.push(last);
  }
  return out;
}
