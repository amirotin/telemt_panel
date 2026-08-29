import { fill, formatNumber, pluralTemplate, type Dict } from "../../i18n";
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

/** The window every «за 15 мин» figure on Сводка is measured over. */
export const HISTORY_WINDOW_SECS = 15 * 60;

// The hub's ring now holds THIRTY minutes (store.MetricCap), and
// useHistorySeries asks for all of it, because a caption like «−0,3 % за 15
// мин» is a comparison and needs two windows. Everything the tiles actually
// display is still the last fifteen: these two functions cut the fetched
// series into "the window" and "the one before it", and every existing
// helper below goes on operating on whichever slice it is handed.
//
// The seam point belongs to BOTH slices on purpose. These series are
// cumulative counters read as newest − oldest, so the boundary reading is
// the previous window's closing value and the current window's opening one;
// dropping it from either side would lose one poll's worth of growth.

// windowSeries narrows a series to the last `secs` seconds of it, measured
// back from its newest point rather than from wall-clock now — a series that
// stopped updating a minute ago should still show its own last fifteen
// minutes, not fourteen. Returns the series untouched when it is empty or
// absent, so callers keep their existing null handling.
export function windowSeries(
  series: HistorySeries | undefined,
  secs: number = HISTORY_WINDOW_SECS,
): HistorySeries | undefined {
  const points = series?.points;
  if (!series || !points || points.length === 0) return series;
  const end = points[points.length - 1].ts;
  return { ...series, points: points.filter((p) => p.ts >= end - secs) };
}

// previousWindowSeries is the `secs` seconds immediately BEFORE
// windowSeries' slice — undefined when the ring does not reach back that
// far yet, which is the honest answer for the first fifteen minutes after
// the panel starts (no previous window exists, so no comparison is claimed).
export function previousWindowSeries(
  series: HistorySeries | undefined,
  secs: number = HISTORY_WINDOW_SECS,
): HistorySeries | undefined {
  const points = series?.points;
  if (!series || !points || points.length === 0) return undefined;
  const seam = points[points.length - 1].ts - secs;
  const prior = points.filter((p) => p.ts >= seam - secs && p.ts <= seam);
  return prior.length === 0 ? undefined : { ...series, points: prior };
}

// historyWindowDelta turns a CUMULATIVE counter series into the amount it
// grew across the series it is handed — so callers cut the window first
// (windowSeries above) rather than trusting whatever /api/history returned.
// The `traffic` metric is the sum of every user's total_octets at
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
  /** Percentage points the quality moved against the PREVIOUS window. Negative is a decline; null until a previous window exists. */
  changePoints: number | null;
}

// connectionQuality answers the fourth tile's question — "do connections
// establish normally?" — from the two monotonic series the hub records
// (internal/hub/counters.go): refusals over attempts across the window
// /api/history returned. Both are counted by the same accumulator, so a
// Telemt restart moves them together and the ratio stays honest.
//
// `changePoints` is the real «−0,3 % за 15 мин» of the concept (§5): this
// window's quality minus the PREVIOUS window's, in percentage points. The
// ring holds thirty minutes (store.MetricCap), so the previous fifteen
// exist — until they do not, in the first quarter-hour after a panel start,
// where changePoints is null and the tile falls back to naming the refusals
// instead of inventing a comparison.
export function connectionQuality(
  attempts: HistorySeries | undefined,
  refusals: HistorySeries | undefined,
  windowSecs: number = HISTORY_WINDOW_SECS,
): ConnectionQuality {
  const current = windowRatio(
    windowSeries(attempts, windowSecs),
    windowSeries(refusals, windowSecs),
  );
  const previous = windowRatio(
    previousWindowSeries(attempts, windowSecs),
    previousWindowSeries(refusals, windowSecs),
  );
  return {
    percent: current.percent,
    refusals: current.refusals,
    changePoints:
      current.percent === null || previous.percent === null
        ? null
        : current.percent - previous.percent,
  };
}

// windowRatio is one window's answer: refusals grown across it, and the
// share of that window's attempts they are. A window with no attempts has
// no percentage — that is "nobody tried", not "everything failed".
function windowRatio(
  attempts: HistorySeries | undefined,
  refusals: HistorySeries | undefined,
): { percent: number | null; refusals: number } {
  const windowRefusals = historyWindowDelta(refusals) ?? 0;
  const windowAttempts = historyWindowDelta(attempts);
  if (windowAttempts === null || windowAttempts <= 0) {
    return { percent: null, refusals: windowRefusals };
  }
  return { percent: 100 - (windowRefusals / windowAttempts) * 100, refusals: windowRefusals };
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

// qualityCaption writes the fourth tile's second line: «−0,3 % за 15 мин»
// when the previous window exists, otherwise the refusal count for this one.
// A change smaller than a tenth of a point rounds to zero and is said as
// «без изменений» — "−0,0 %" reads as a decline that did not happen.
export function qualityCaption(quality: ConnectionQuality, s: Dict): string {
  if (quality.changePoints !== null) {
    const points = round1(quality.changePoints);
    if (points === 0) return s.pulse.stat.qualityUnchanged;
    const sign = points > 0 ? "+" : MINUS;
    return fill(s.pulse.stat.qualityChange, {
      value: `${sign}${formatNumber(s, Math.abs(points))}`,
    });
  }
  return quality.refusals > 0
    ? pluralTemplate(s, quality.refusals, s.pulse.stat.refusalsInWindow)
    : s.pulse.stat.noRefusals;
}

// U+2212, not a hyphen: a minus sign in front of a figure is typography,
// and a hyphen at that size reads as a dash between two words.
const MINUS = "\u2212";

/** Rounds to one decimal — the precision every percentage on Сводка is written to. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
