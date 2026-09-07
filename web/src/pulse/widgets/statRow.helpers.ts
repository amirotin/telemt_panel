import { fill, formatNumber, pluralTemplate, type Dict } from "../../i18n";
import type { StatsSnapshot } from "../../realtime/topics";
import type { HistorySeries } from "../../lib/api/generated/types.gen";
import { completeCounterWindow, counterRates, counterSteps, historyPointEnd, matchingCounterSteps, sliceHistory } from "./historyIntervals.helpers";

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

// useHistorySeries requests thirty minutes of the two-hour live buffer,
// because a caption like «−0,3 % за 15
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
  const end = historyPointEnd(points[points.length - 1]);
  return sliceHistory(series, end - secs, end);
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
  const seam = historyPointEnd(points[points.length - 1]) - secs;
  const prior = sliceHistory(series, seam - secs, seam);
  return prior.points.length === 0 ? undefined : prior;
}

// Sum known counter movement, not lifetime totals. A single aggregate can
// contain a measured delta; a single raw sample cannot. Unknown reset/gap
// intervals add nothing, while observed movement on both sides is retained.
export function historyWindowDelta(series: HistorySeries | undefined): number | null {
  const { steps } = counterSteps(series);
  return steps.length ? steps.reduce((sum, step) => sum + step.delta, 0) : null;
}

// Rates are bytes per observed second, so a five-minute bucket cannot look
// like a spike beside a five-second poll. Unknown intervals break the curve.
export function deltaSparklineValues(series: HistorySeries | undefined): number[] {
  return counterRates(series);
}

// peakHistoryValue — the highest point in a series, for the row's "пик за
// 15 мин — N" sub-line (the prototype's own secondary metric line). Only
// meaningful for instantaneous gauges: on a cumulative counter the maximum
// is simply the last point, so callers skip it there.
export function peakHistoryValue(series: HistorySeries | undefined): number | null {
  const points = series?.points;
  if (!points || points.length === 0) return null;
  return points.reduce((peak, p) => Math.max(peak, p.max ?? p.v), points[0].max ?? points[0].v);
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
// request covers thirty minutes, so the previous fifteen
// exist — until they do not, in the first quarter-hour after a panel start,
// where changePoints is null and the tile falls back to naming the refusals
// instead of inventing a comparison.
export function connectionQuality(
  attempts: HistorySeries | undefined,
  refusals: HistorySeries | undefined,
  windowSecs: number = HISTORY_WINDOW_SECS,
): ConnectionQuality {
  const windows = [windowSeries(attempts, windowSecs), windowSeries(refusals, windowSecs),
    previousWindowSeries(attempts, windowSecs), previousWindowSeries(refusals, windowSecs)];
  const current = windowRatio(
    windows[0], windows[1],
  );
  const previous = windowRatio(
    windows[2], windows[3],
  );
  return {
    percent: current.percent,
    refusals: current.refusals,
    changePoints:
      current.percent === null || previous.percent === null || !windows.every(series => completeCounterWindow(series, windowSecs))
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
  const steps = matchingCounterSteps(attempts, refusals);
  const windowAttempts = steps?.reduce((sum, step) => sum + step.delta, 0) ?? 0;
  if (!steps || windowAttempts <= 0) {
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
  let out: number[] = [], last: number | undefined, end: number | undefined;
  for (const step of matchingCounterSteps(attempts, refusals) ?? []) {
    if (end !== step.from) { out = []; last = undefined; }
    if (step.delta > 0) last = 100 - (step.refused / step.delta) * 100;
    if (last !== undefined) out.push(last);
    end = step.to;
  }
  const a = attempts?.points.at(-1), r = refusals?.points.at(-1);
  return a && r && end === historyPointEnd(a) && end === historyPointEnd(r) ? out : [];
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
