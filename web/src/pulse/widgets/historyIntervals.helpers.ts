import type { HistorySeries } from "../../lib/api/generated/types.gen";

type Point = HistorySeries["points"][number];
// Same continuity limit as store.metricObservationGap; bucket widths are not gaps.
const OBSERVATION_GAP = 120;
const TIER_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };

export interface CounterStep {
  from: number;
  to: number;
  delta: number;
  seconds: number;
  complete: boolean;
}

export function historyPointStart(point: Point): number {
  return point.first_observed_epoch_secs ?? point.ts;
}

export function historyPointEnd(point: Point): number {
  return point.last_observed_epoch_secs ?? (point.tier ? point.ts + TIER_SECONDS[point.tier] : point.ts);
}

function isCounter(series: HistorySeries): boolean {
  return ["traffic", "attempts", "refusals"].includes(series.metric);
}

function counterObservation(point: Point) {
  if (!point.tier) {
    return { first: point.ts, last: point.ts, firstValue: point.v };
  }
  if (point.first_observed_epoch_secs === undefined || point.last_observed_epoch_secs === undefined) return null;
  // Older API responses can recover the first value only with known continuity.
  const firstValue = point.first_observed_value ?? (point.gaps === 0 && point.observed_delta !== undefined ? point.v - point.observed_delta : undefined);
  if (firstValue === undefined) return null;
  return { first: point.first_observed_epoch_secs, last: point.last_observed_epoch_secs, firstValue };
}

// Clip only at actual observations. Never apportion a bucket by its wall-clock
// overlap: its traffic/peak may have occurred entirely outside that overlap.
export function sliceHistory(series: HistorySeries, from: number, to: number): HistorySeries {
  const points: Point[] = [];
  let partial = false;
  for (const point of series.points) {
    const first = historyPointStart(point), last = historyPointEnd(point);
    if (last < from || first > to) continue;
    if (first >= from && last <= to) {
      points.push(point);
      continue;
    }
    partial ||= (first < from && last > from) || (first < to && last > to);
    if (!isCounter(series)) continue;
    const observed = counterObservation(point);
    if (!observed) continue;
    if (first >= from && first <= to) points.push({ ts: first, v: observed.firstValue });
    if (last >= from && last <= to) points.push({ ts: last, v: point.v });
  }
  const result = { ...series, requested_from_epoch_secs: from, points };
  if (isCounter(series)) partial ||= counterSteps(result).partial;
  return partial && result.state === "ready" ? { ...result, state: "partial" } : result;
}

// Each segment carries actual duration and observed growth. A reset or outage
// breaks the bridge but does not erase known movement on either side.
export function counterSteps(series: HistorySeries | undefined): { steps: CounterStep[]; partial: boolean } {
  const steps: CounterStep[] = [];
  let previous: { ts: number; value: number } | null = null;
  let partial = false;
  for (const point of series?.points ?? []) {
    const observation = counterObservation(point);
    if (!observation || ![point.v, observation.first, observation.last, observation.firstValue].every(Number.isFinite) || observation.last < observation.first) {
      partial = true;
      previous = null;
      continue;
    }
    const { first, last, firstValue } = observation;
    if (previous) {
      const seconds = first - previous.ts, delta = firstValue - previous.value;
      if (seconds > 0 && seconds <= OBSERVATION_GAP && delta >= 0) {
        steps.push({ from: previous.ts, to: first, delta, seconds, complete: true });
      } else if (seconds !== 0 || delta !== 0) {
        partial = true;
        if (seconds < 0) {
          // Overlapping aggregates cannot be split into independent deltas.
          previous = last > previous.ts ? { ts: last, value: point.v } : previous;
          continue;
        }
      }
    }
    if (last > first) {
      const delta = point.observed_delta, seconds = point.observed_seconds;
      if (delta !== undefined && Number.isFinite(delta) && delta >= 0 && seconds !== undefined && seconds > 0 && seconds <= last - first) {
        const complete = point.gaps === 0 && seconds === last - first;
        steps.push({ from: first, to: last, delta, seconds, complete });
        partial ||= !complete;
      } else {
        partial = true;
      }
    }
    previous = { ts: last, value: point.v };
  }
  return { steps, partial };
}

export function matchingCounterSteps(attempts: HistorySeries | undefined, refusals: HistorySeries | undefined) {
  const a = counterSteps(attempts).steps, r = counterSteps(refusals).steps;
  if (!a.length || a.length !== r.length) return null;
  if (a.some((step, i) => !step.complete || !r[i].complete || step.from !== r[i].from || step.to !== r[i].to || step.seconds !== r[i].seconds || r[i].delta > step.delta)) return null;
  return a.map((step, i) => ({ ...step, refused: r[i].delta }));
}

export function completeCounterWindow(series: HistorySeries | undefined, secs: number): boolean {
  if (!series || series.state !== "ready") return false;
  const { steps, partial } = counterSteps(series);
  if (partial || !steps.length) return false;
  // Allow one poll of boundary skew, not a short fragment of a second window.
  const tolerance = Math.min(60, ...steps.map(step => step.seconds));
  return steps[0].from <= series.requested_from_epoch_secs + tolerance &&
    steps.at(-1)!.to >= series.requested_from_epoch_secs + secs - tolerance;
}

// The decorative chart has no gap axis. Show only its latest continuous run
// instead of drawing an artificial connection through unknown observations.
export function counterRates(series: HistorySeries | undefined): number[] {
  let values: number[] = [], end: number | undefined;
  for (const step of counterSteps(series).steps) {
    if (end !== step.from || !step.complete) values = [];
    if (step.complete) values.push(step.delta / step.seconds);
    end = step.to;
  }
  const latest = series?.points.at(-1);
  return latest && end === historyPointEnd(latest) ? values : [];
}
