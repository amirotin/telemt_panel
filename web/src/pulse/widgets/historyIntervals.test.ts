import { describe, expect, it } from "vitest";
import type { HistorySeries } from "../../lib/api/generated/types.gen";
import { connectionQuality, deltaSparklineValues, historyWindowDelta, peakHistoryValue, previousWindowSeries, qualitySparklineValues, windowSeries } from "./statRow.helpers";

type Point = HistorySeries["points"][number];
function series(metric: string, points: Point[]): HistorySeries {
  return { metric, points, range: "30m", state: "ready", requested_from_epoch_secs: 0, retention_secs: 7200 };
}
function bucket(start: number, first: number, last: number, duration = 295): Point {
  return {
    ts: start, v: last, tier: "5m", samples: duration / 5 + 1,
    min: first, max: last, first_observed_value: first,
    first_observed_epoch_secs: start, last_observed_epoch_secs: start + duration,
    observed_delta: last - first, observed_seconds: duration, gaps: 0,
  };
}

describe("mixed-resolution KPI history", () => {
  it("reads the observed delta from a single aggregate", () => {
    expect(historyWindowDelta(series("traffic", [bucket(300, 1000, 2000)]))).toBe(1000);
  });

  it("includes the first bucket and bridges to live observations without double counting", () => {
    const data = series("traffic", [bucket(0, 0, 2950), bucket(300, 3000, 5950), { ts: 600, v: 6000 }, { ts: 605, v: 6050 }]);
    expect(historyWindowDelta(data)).toBe(6050);
    expect(deltaSparklineValues(data).every(v => v === 10)).toBe(true);
  });

  it("normalizes rate by observation duration, not by the number of API points", () => {
    expect(deltaSparklineValues(series("traffic", [{ ts: 0, v: 0 }, { ts: 5, v: 50 }, { ts: 15, v: 150 }]))).toEqual([10, 10]);
  });

  it("keeps known growth on both sides of a reset without inventing reset traffic", () => {
    const data = series("traffic", [{ ts: 0, v: 100 }, { ts: 5, v: 500 }, { ts: 10, v: 20 }, { ts: 15, v: 50 }]);
    expect(historyWindowDelta(data)).toBe(430);
    expect(deltaSparklineValues(data)).toEqual([6]);
  });

  it("does not bridge an observation outage or draw a line across it", () => {
    const data = series("traffic", [{ ts: 0, v: 0 }, { ts: 5, v: 50 }, { ts: 300, v: 10000 }, { ts: 305, v: 10050 }]);
    expect(historyWindowDelta(data)).toBe(100);
    expect(deltaSparklineValues(data)).toEqual([10]);
  });

  it("does not infer a counter delta from legacy bucket averages", () => {
    const data = series("traffic", [{ ts: 0, v: 100, tier: "1m" }, { ts: 60, v: 200, tier: "1m" }]);
    expect(historyWindowDelta(data)).toBeNull();
    expect(deltaSparklineValues(data)).toEqual([]);
  });

  it("anchors windows to the last observation rather than the start of its bucket", () => {
    const data = series("traffic", [bucket(0, 0, 2950), bucket(900, 9000, 11950)]);
    const current = windowSeries(data)!;
    expect(current.requested_from_epoch_secs).toBe(295);
    expect(current.points[0]).toEqual({ ts: 295, v: 2950 });
  });

  it("does not count a bucket twice when it straddles the fifteen-minute seam", () => {
    const data = series("traffic", [bucket(0, 0, 2950), bucket(300, 3000, 5950), bucket(600, 6000, 8950), { ts: 1000, v: 10000 }]);
    const current = windowSeries(data)!;
    expect(current.requested_from_epoch_secs).toBe(100);
    expect(current.points[0]).toEqual({ ts: 295, v: 2950 });
    expect(current.state).toBe("partial");
    expect(historyWindowDelta(current)).toBe(7050);
    expect(historyWindowDelta(previousWindowSeries(data))).toBeNull();
  });

  it("does not attribute a pre-window gauge peak to the current window", () => {
    const data = series("connections", [{ ...bucket(0, 1, 2), max: 99 }, { ts: 1000, v: 3 }]);
    expect(peakHistoryValue(windowSeries(data))).toBe(3);
    expect(windowSeries(data)?.state).toBe("partial");
  });

  it("compares matching fifteen-minute windows across a restart", () => {
    const make = (metric: string, value: (ts: number) => number) => series(metric, [
      ...Array.from({ length: 5 }, (_, i) => bucket(i * 300, value(i * 300), value(i * 300 + 295))),
      ...Array.from({ length: 61 }, (_, i) => ({ ts: 1500 + i * 5, v: value(1500 + i * 5) })),
    ]);
    const attempts = make("attempts", ts => ts * 20);
    const refusals = make("refusals", ts => ts <= 900 ? ts / 5 : 180 + ts - 900);
    const quality = connectionQuality(attempts, refusals);
    expect(quality.percent).toBe(95);
    expect(quality.refusals).toBe(900);
    expect(quality.changePoints).toBe(-4);
  });

  it("does not report perfect quality when the refusal series is missing", () => {
    expect(connectionQuality(series("attempts", [{ ts: 0, v: 0 }, { ts: 5, v: 100 }]), undefined).percent).toBeNull();
  });

  it("does not pair counters from different observation intervals", () => {
    const attempts = series("attempts", [{ ts: 0, v: 0 }, { ts: 5, v: 100 }]);
    const refusals = series("refusals", [{ ts: 5, v: 0 }, { ts: 10, v: 10 }]);
    expect(connectionQuality(attempts, refusals).percent).toBeNull();
    expect(qualitySparklineValues(attempts, refusals)).toEqual([]);
  });

  it("does not compare a complete current window with a short previous fragment", () => {
    const make = (metric: string, scale: number) => series(metric, Array.from({ length: 191 }, (_, i) => ({ ts: i * 5, v: i * scale })));
    const quality = connectionQuality(make("attempts", 100), make("refusals", 1));
    expect(quality.percent).toBe(99);
    expect(quality.changePoints).toBeNull();
  });

  it("does not leave the old curve on screen after an unobserved tail", () => {
    const attempts = series("attempts", [{ ts: 0, v: 0 }, { ts: 5, v: 100 }, { ts: 300, v: 200 }]);
    const refusals = series("refusals", [{ ts: 0, v: 0 }, { ts: 5, v: 1 }, { ts: 300, v: 10 }]);
    expect(deltaSparklineValues(attempts)).toEqual([]);
    expect(qualitySparklineValues(attempts, refusals)).toEqual([]);
  });

  it("preserves measured growth inside a gapped aggregate without pretending it is continuous", () => {
    const point = { ...bucket(0, 100, 200), observed_delta: 30, observed_seconds: 5, gaps: 1 };
    const data = series("traffic", [point]);
    expect(historyWindowDelta(data)).toBe(30);
    expect(windowSeries(data)?.state).toBe("partial");
    expect(deltaSparklineValues(data)).toEqual([]);
    expect(connectionQuality(series("attempts", [point]), series("refusals", [{ ...point, v: 1, observed_delta: 1 }])).percent).toBeNull();
  });

  it("supports older API aggregate metadata only when the initial value is recoverable", () => {
    const point = bucket(0, 0, 2950);
    delete point.first_observed_value;
    expect(historyWindowDelta(series("traffic", [point, { ts: 300, v: 3000 }]))).toBe(3000);
    expect(historyWindowDelta(series("traffic", [{ ...point, gaps: 1 }]))).toBeNull();
  });

  it("does not double count duplicate seam observations", () => {
    const data = series("traffic", [bucket(0, 0, 2950), { ts: 295, v: 2950 }, { ts: 300, v: 3000 }]);
    expect(historyWindowDelta(data)).toBe(3000);
    expect(deltaSparklineValues(data)).toEqual([10, 10]);
  });
});
