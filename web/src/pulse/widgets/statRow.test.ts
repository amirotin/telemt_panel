import { describe, expect, it } from "vitest";
import {
  computeStatRowValues,
  deltaSparklineValues,
  historyWindowDelta,
  peakHistoryValue,
  sparklineValues,
} from "./statRow.helpers";
import type { StatsSnapshot } from "../../realtime/topics";
import type { HistorySeries } from "../../lib/api/generated/types.gen";
import { ru as s } from "../../i18n";

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { health: null, summary: null, ready: null, ...overrides };
}

describe("computeStatRowValues", () => {
  it("returns nulls/approx for a not-yet-loaded topic", () => {
    expect(computeStatRowValues(null, s)).toEqual({
      connections: null,
      connectionsApprox: true,
      activeUsers: null,
      activeUsersApprox: true,
      uptimeLabel: "—",
    });
  });

  it("falls back to the summary's coarse proxies when runtime_edge is off", () => {
    const view = computeStatRowValues(
      stats({ summary: { uptime_seconds: 3661, connections_total: 42, connections_bad_total: 0, handshake_timeouts_total: 0, configured_users: 7 } }),
      s,
    );
    expect(view.connections).toBe(42);
    expect(view.connectionsApprox).toBe(true);
    expect(view.activeUsers).toBe(7);
    expect(view.activeUsersApprox).toBe(true);
    expect(view.uptimeLabel).toBe("1 ч.");
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
      s,
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
      s,
    );
    expect(view.connections).toBe(9);
    expect(view.connectionsApprox).toBe(true);
  });

  it("prefers stats.uptime_seconds (SystemInfo) over summary.uptime_seconds when both exist", () => {
    const view = computeStatRowValues(
      stats({ uptime_seconds: 7200, summary: { uptime_seconds: 1, connections_total: 0, connections_bad_total: 0, handshake_timeouts_total: 0, configured_users: 0 } }),
      s,
    );
    expect(view.uptimeLabel).toBe("2 ч.");
  });
});

describe("sparklineValues", () => {
  const series: HistorySeries = { metric: "connections", range: "15m", points: [{ ts: 1, v: 1 }, { ts: 2, v: 5 }] };

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
