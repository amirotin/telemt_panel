import { describe, expect, it } from "vitest";
import { ru } from "../../i18n";
import {
  computeStatRowValues,
  deltaSparklineValues,
  historyWindowDelta,
  lastHistoryValue,
  peakHistoryValue,
  previousWindowSeries,
  qualityCaption,
  connectionQuality,
  windowSeries,
  qualitySparklineValues,
  sparklineValues,
} from "./statRow.helpers";
import type { StatsSnapshot } from "../../realtime/topics";
import type { HistorySeries } from "../../lib/api/generated/types.gen";

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { health: null, summary: null, ready: null, ...overrides };
}

describe("computeStatRowValues", () => {
  it("returns nulls/approx for a not-yet-loaded topic", () => {
    expect(computeStatRowValues(null)).toEqual({
      connections: null,
      connectionsApprox: true,
      activeUsers: null,
      activeUsersApprox: true,
    });
  });

  it("falls back to the summary's coarse proxies when runtime_edge is off", () => {
    const view = computeStatRowValues(
      stats({ summary: { uptime_seconds: 3661, connections_total: 42, connections_bad_total: 0, handshake_timeouts_total: 0, configured_users: 7 } }),
    );
    expect(view.connections).toBe(42);
    expect(view.connectionsApprox).toBe(true);
    expect(view.activeUsers).toBe(7);
    expect(view.activeUsersApprox).toBe(true);
  });

  it("prefers the live runtime_edge totals when enabled", () => {
    const view = computeStatRowValues(
      stats({
        connections_summary: {
          enabled: true,
          generated_at_epoch_secs: 0,
          data: { cache: { ttl_ms: 0, served_from_cache: false, stale_cache_used: false }, totals: { current_connections: 5, current_connections_me: 3, current_connections_direct: 2, active_users: 4 }, top: { limit: 0, by_connections: [], by_throughput: [] }, telemetry: { user_enabled: false, throughput_is_cumulative: false } },
        },
      }),
    );
    expect(view.connections).toBe(5);
    expect(view.connectionsApprox).toBe(false);
    expect(view.activeUsers).toBe(4);
    expect(view.activeUsersApprox).toBe(false);
  });

  it("falls back to the summary proxy when connections_summary is present but disabled", () => {
    const view = computeStatRowValues(
      stats({
        summary: { uptime_seconds: 0, connections_total: 9, connections_bad_total: 0, handshake_timeouts_total: 0, configured_users: 3 },
        connections_summary: { enabled: false, reason: "minimal runtime disabled", generated_at_epoch_secs: 0, data: null },
      }),
    );
    expect(view.connections).toBe(9);
    expect(view.connectionsApprox).toBe(true);
  });

});

describe("sparklineValues", () => {
  const series: HistorySeries = { metric: "connections", range: "15m",
    retention_secs: 1800, points: [{ ts: 1, v: 1 }, { ts: 2, v: 5 }] };

  it("extracts the raw value series", () => {
    expect(sparklineValues(series)).toEqual([1, 5]);
  });

  it("degrades to empty when there's no history yet", () => {
    expect(sparklineValues(undefined)).toEqual([]);
  });
});

describe("historyWindowDelta", () => {
  const traffic = (values: number[]): HistorySeries => ({
    metric: "traffic",
    range: "15m",
    retention_secs: 1800,
    points: values.map((v, i) => ({ ts: i + 1, v })),
  });

  it("returns newest − oldest across a monotonic cumulative series", () => {
    expect(historyWindowDelta(traffic([1_000, 1_500, 4_000]))).toBe(3_000);
  });

  it("is null with fewer than two points — never the cumulative value itself", () => {
    expect(historyWindowDelta(undefined)).toBeNull();
    expect(historyWindowDelta(traffic([]))).toBeNull();
    // The VPS defect: one point holding a 256 GB lifetime total must render
    // as «—», not as "traffic over the last 15 minutes".
    expect(historyWindowDelta(traffic([274_877_906_944]))).toBeNull();
  });

  it("treats a counter reset as the amount accumulated since the reset", () => {
    expect(historyWindowDelta(traffic([9_000, 9_500, 120]))).toBe(120);
  });

  it("is zero for a flat series — a real 'no traffic this window' answer", () => {
    expect(historyWindowDelta(traffic([4_000, 4_000, 4_000]))).toBe(0);
  });
});

describe("deltaSparklineValues", () => {
  const traffic = (values: number[]): HistorySeries => ({
    metric: "traffic",
    range: "15m",
    retention_secs: 1800,
    points: values.map((v, i) => ({ ts: i + 1, v })),
  });

  it("plots per-step deltas (the rate shape), not the cumulative ramp", () => {
    expect(deltaSparklineValues(traffic([100, 150, 400, 400]))).toEqual([50, 250, 0]);
  });

  it("has no steps at all below two points", () => {
    expect(deltaSparklineValues(undefined)).toEqual([]);
    expect(deltaSparklineValues(traffic([]))).toEqual([]);
    expect(deltaSparklineValues(traffic([42]))).toEqual([]);
  });

  it("takes the post-reset value as that step's delta instead of going negative", () => {
    expect(deltaSparklineValues(traffic([500, 900, 30, 80]))).toEqual([400, 30, 50]);
  });
});

describe("peakHistoryValue", () => {
  const withPoints = (points: HistorySeries["points"]): HistorySeries => ({
    metric: "connections",
    range: "15m",
    retention_secs: 1800,
    points,
  });

  it("returns the highest point of the series", () => {
    expect(
      peakHistoryValue(withPoints([{ ts: 1, v: 3 }, { ts: 2, v: 9 }, { ts: 3, v: 4 }])),
    ).toBe(9);
  });

  it("returns null for a missing or empty series", () => {
    expect(peakHistoryValue(undefined)).toBeNull();
    expect(peakHistoryValue(withPoints([]))).toBeNull();
  });
});

function refusalSeries(values: number[]): HistorySeries {
  return { metric: "refusals", range: "15m",
    retention_secs: 1800, points: values.map((v, i) => ({ ts: i, v })) };
}

describe("lastHistoryValue", () => {
  it("is the newest point — a cumulative counter's lifetime figure", () => {
    expect(lastHistoryValue(refusalSeries([3, 9, 20]))).toBe(20);
  });

  it("is null for an empty or missing series", () => {
    expect(lastHistoryValue(refusalSeries([]))).toBeNull();
    expect(lastHistoryValue(undefined)).toBeNull();
  });
});

describe("connectionQuality", () => {
  // Points every 5s, the hub's own poll cadence, ending at ts 0 — so index
  // -1 is five seconds ago and the 15-minute seam falls 180 points back.
  // Timestamps matter now: the tile reads the LAST fifteen minutes and
  // compares them against the fifteen before, out of one 30-minute fetch.
  const STEP = 5;
  function series(metric: string, values: number[]): HistorySeries {
    const last = values.length - 1;
    return {
      metric,
      range: "30m",
      retention_secs: 1800,
      points: values.map((v, i) => ({ ts: (i - last) * STEP, v })),
    };
  }
  /** A 30-minute fetch: `count` points ending now, at STEP seconds apart. */
  function ramp(metric: string, count: number, at: (i: number) => number): HistorySeries {
    return series(
      metric,
      Array.from({ length: count }, (_, i) => at(i)),
    );
  }

  it("is the share of the window's attempts that were not refused", () => {
    const q = connectionQuality(
      series("attempts", [0, 250, 500, 750, 1000]),
      series("refusals", [0, 2, 4, 6, 10]),
    );
    expect(q.percent).toBe(99);
    expect(q.refusals).toBe(10);
  });

  // No attempts is not 0 % quality — it is no answer.
  it("has no percentage when nothing was attempted in the window", () => {
    const q = connectionQuality(series("attempts", [7, 7, 7]), series("refusals", [0, 0, 0]));
    expect(q.percent).toBeNull();
  });

  // The whole point of the 30-minute ring (store.MetricCap): the caption
  // «−0,3 % за 15 мин» is this window against the previous one, not two
  // halves of the same one.
  it("compares the window against the previous window, in percentage points", () => {
    // 360 points = 30 minutes. 100 attempts per step throughout; the older
    // half refuses 1 per step (99 %), the newer half refuses 5 (95 %).
    const attempts = ramp("attempts", 361, (i) => i * 100);
    const refusals = ramp("refusals", 361, (i) => (i <= 180 ? i : 180 + (i - 180) * 5));
    const q = connectionQuality(attempts, refusals);
    expect(Math.round(q.percent!)).toBe(95);
    expect(Math.round(q.changePoints!)).toBe(-4);
  });

  it("reports an improvement as a positive change", () => {
    const attempts = ramp("attempts", 361, (i) => i * 100);
    const refusals = ramp("refusals", 361, (i) => (i <= 180 ? i * 5 : 900 + (i - 180)));
    const q = connectionQuality(attempts, refusals);
    expect(Math.round(q.changePoints!)).toBe(4);
  });

  // The first quarter-hour after a panel start: the ring simply does not
  // reach back far enough, and the tile must not invent a comparison.
  it("has no change while only one window has been recorded", () => {
    const attempts = ramp("attempts", 120, (i) => i * 100);
    const refusals = ramp("refusals", 120, (i) => i);
    const q = connectionQuality(attempts, refusals);
    expect(q.percent).toBe(99);
    expect(q.changePoints).toBeNull();
  });

  it("has no change for a series too short to compare", () => {
    const q = connectionQuality(series("attempts", [0, 100]), series("refusals", [0, 1]));
    expect(q.percent).toBe(99);
    expect(q.changePoints).toBeNull();
  });

  // A previous window with no attempts in it is not a 0 % window.
  it("has no change when the previous window attempted nothing", () => {
    const attempts = ramp("attempts", 361, (i) => (i <= 180 ? 0 : (i - 180) * 100));
    const refusals = ramp("refusals", 361, (i) => (i <= 180 ? 0 : i - 180));
    const q = connectionQuality(attempts, refusals);
    expect(q.percent).not.toBeNull();
    expect(q.changePoints).toBeNull();
  });

  it("is empty rather than throwing before either series has arrived", () => {
    expect(connectionQuality(undefined, undefined)).toEqual({
      percent: null,
      refusals: 0,
      changePoints: null,
    });
  });
});

describe("windowSeries / previousWindowSeries", () => {
  const STEP = 5;
  function series(count: number): HistorySeries {
    const last = count - 1;
    return {
      metric: "attempts",
      range: "30m",
      retention_secs: 1800,
      points: Array.from({ length: count }, (_, i) => ({ ts: (i - last) * STEP, v: i })),
    };
  }

  it("keeps only the last fifteen minutes", () => {
    // 361 points at 5s = 30 minutes; the last 15 are 181 points, seam included.
    expect(windowSeries(series(361))!.points.length).toBe(181);
  });

  it("hands the previous fifteen minutes back as their own series", () => {
    const prior = previousWindowSeries(series(361))!;
    expect(prior.points.length).toBe(181);
    // The seam reading belongs to both slices: the previous window's close
    // is the current window's open, and a cumulative delta needs both ends.
    expect(prior.points[prior.points.length - 1].ts).toBe(windowSeries(series(361))!.points[0].ts);
  });

  it("has no previous window while the ring holds one", () => {
    expect(previousWindowSeries(series(60))).toBeUndefined();
    expect(previousWindowSeries(undefined)).toBeUndefined();
  });

  it("passes an empty or absent series through untouched", () => {
    expect(windowSeries(undefined)).toBeUndefined();
    const empty = { metric: "attempts", range: "30m", retention_secs: 1800, points: [] };
    expect(windowSeries(empty)).toBe(empty);
  });
});

describe("qualitySparklineValues", () => {
  function series(metric: string, values: number[]): HistorySeries {
    return { metric, range: "30m", retention_secs: 1800, points: values.map((v, i) => ({ ts: i, v })) };
  }

  it("plots one point per step", () => {
    const values = qualitySparklineValues(
      series("attempts", [0, 100, 200]),
      series("refusals", [0, 1, 5]),
    );
    expect(values).toEqual([99, 96]);
  });

  // An idle five seconds is not an outage: the previous value carries.
  it("carries the last value through a step with no attempts", () => {
    const values = qualitySparklineValues(
      series("attempts", [0, 100, 100]),
      series("refusals", [0, 2, 2]),
    );
    expect(values).toEqual([98, 98]);
  });

  it("is empty for a series with no steps", () => {
    expect(qualitySparklineValues(undefined, undefined)).toEqual([]);
  });
});

describe("qualityCaption", () => {
  it("names the movement against the previous window, with a real minus sign", () => {
    const caption = qualityCaption({ percent: 99.4, refusals: 11, changePoints: -0.3 }, ru);
    expect(caption).toBe("\u22120,3 % за 15 мин");
    expect(caption).not.toContain("-");
  });

  it("signs an improvement", () => {
    expect(qualityCaption({ percent: 99.9, refusals: 1, changePoints: 0.4 }, ru)).toBe(
      "+0,4 % за 15 мин",
    );
  });

  // "−0,0 %" would read as a decline that did not happen.
  it("says «без изменений» for a movement that rounds to zero", () => {
    expect(qualityCaption({ percent: 100, refusals: 0, changePoints: -0.02 }, ru)).toBe(
      "без изменений за 15 мин",
    );
  });

  // The first quarter-hour after a panel start: no previous window exists,
  // so the tile names this window's refusals instead of inventing a change.
  it("falls back to the refusal count while there is no previous window", () => {
    expect(qualityCaption({ percent: 99, refusals: 11, changePoints: null }, ru)).toBe(
      "11 отказов за 15 мин",
    );
    expect(qualityCaption({ percent: 100, refusals: 0, changePoints: null }, ru)).toBe(
      "без отказов за 15 мин",
    );
  });
});
