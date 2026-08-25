import { describe, expect, it } from "vitest";
import { computeProblems, problemSeverity } from "./problems.helpers";
import type { DcStatus, DcStatusData, StatsSnapshot } from "../../realtime/topics";
import { ru as s } from "../../i18n";

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { health: null, summary: null, ready: null, ...overrides };
}

// mkDc fills every DcStatus field (internal/telemt/types_stats.go's DcStatus
// json tags) with a neutral default, overridable per test — mirrors the
// existing stats() fixture builder's convention for this file.
function mkDc(overrides: Partial<DcStatus> = {}): DcStatus {
  return {
    dc: 1,
    endpoints: [],
    endpoint_writers: [],
    available_endpoints: 0,
    available_pct: 0,
    required_writers: 0,
    floor_min: 0,
    floor_target: 0,
    floor_max: 0,
    floor_capped: false,
    alive_writers: 0,
    coverage_pct: 0,
    fresh_alive_writers: 0,
    fresh_coverage_pct: 0,
    rtt_ms: null,
    load: 0,
    ...overrides,
  };
}

function dcsData(dcs: DcStatus[], overrides: Partial<DcStatusData> = {}): DcStatusData {
  return { middle_proxy_enabled: true, generated_at_epoch_secs: 0, dcs, ...overrides };
}

// edgeTotals builds a full StatsSnapshot["connections_summary"] carrying the
// given current_connections_me/direct pair (internal/telemt/types_runtime_edge.go's
// RuntimeEdgeConnectionTotals json tags) — only the split-traffic check reads it.
function edgeTotals(me: number, direct: number): StatsSnapshot["connections_summary"] {
  return {
    enabled: true,
    data: {
      cache: { ttl_ms: 0, served_from_cache: false, stale_cache_used: false },
      totals: { current_connections: me + direct, current_connections_me: me, current_connections_direct: direct, active_users: 1 },
      top: { limit: 0, by_connections: [], by_throughput: [] },
      telemetry: { user_enabled: false, throughput_is_cumulative: false },
    },
  };
}

describe("computeProblems", () => {
  it("returns nothing when there is nothing to report", () => {
    expect(computeProblems(null, [], [], null, s)).toEqual([]);
    expect(computeProblems(stats(), [], [], null, s)).toEqual([]);
  });

  it("reports not-ready with its reason first", () => {
    const items = computeProblems(
      stats({ ready: { ready: false, status: "not_ready", reason: "no upstreams", admission_open: false, healthy_upstreams: 0, total_upstreams: 1 } }),
      [],
      [],
      null,
      s,
    );
    expect(items[0]).toEqual({ key: "not_ready", label: "Telemt не готов", detail: "no upstreams" });
  });

  it("reports read_only", () => {
    const items = computeProblems(stats({ health: { status: "ok", read_only: true } }), [], [], null, s);
    expect(items.some((i) => i.key === "read_only")).toBe(true);
  });

  it("does not report not-ready when ready is true", () => {
    const items = computeProblems(
      stats({ ready: { ready: true, status: "ready", admission_open: true, healthy_upstreams: 1, total_upstreams: 1 } }),
      [],
      [],
      null,
      s,
    );
    expect(items).toEqual([]);
  });

  it("reports each stale/errored topic", () => {
    const items = computeProblems(
      stats(),
      [
        { topic: "runtime", stale: true, error: null },
        { topic: "security", stale: false, error: "telemt_unreachable" },
        { topic: "upstreams", stale: false, error: null },
      ],
      [],
      null,
      s,
    );
    expect(items.map((i) => i.key)).toEqual(["stale_runtime", "stale_security"]);
    expect(items[1].detail).toBe("telemt_unreachable");
  });

  it("ranks handshake failures descending by count and drops zero-count classes", () => {
    const items = computeProblems(
      stats({
        summary: {
          uptime_seconds: 0,
          connections_total: 0,
          connections_bad_total: 0,
          handshake_timeouts_total: 0,
          configured_users: 0,
          handshake_failures_by_class: [
            { class: "timeout", total: 3 },
            { class: "bad_secret", total: 10 },
            { class: "unused", total: 0 },
          ],
        },
      }),
      [],
      [],
      null,
      s,
    );
    expect(items.map((i) => i.key)).toEqual(["handshake_bad_secret", "handshake_timeout"]);
  });

  it("reports missing capabilities last", () => {
    const items = computeProblems(stats(), [], ["runtime_edge", "quota"], null, s);
    expect(items.map((i) => i.key)).toEqual(["cap_runtime_edge", "cap_quota"]);
  });

  it("reports connections_bad_total and handshake_timeouts_total only when non-zero", () => {
    const zero = computeProblems(
      stats({ summary: { uptime_seconds: 0, connections_total: 0, connections_bad_total: 0, handshake_timeouts_total: 0, configured_users: 0 } }),
      [],
      [],
      null,
      s,
    );
    expect(zero).toEqual([]);

    const nonZero = computeProblems(
      stats({ summary: { uptime_seconds: 0, connections_total: 0, connections_bad_total: 4, handshake_timeouts_total: 2, configured_users: 0 } }),
      [],
      [],
      null,
      s,
    );
    expect(nonZero.map((i) => i.key)).toEqual(["connections_bad_total", "handshake_timeouts_total"]);
    expect(nonZero[0].detail).toBe("4");
    expect(nonZero[1].detail).toBe("2");
  });

  it("does not treat a null summary (failed sub-call) as zero bad connections", () => {
    // stats() defaults summary to null — a distinct case from an explicit
    // summary object whose counters happen to be 0.
    expect(computeProblems(stats(), [], [], null, s)).toEqual([]);
  });

  it("ranks connections_bad_by_class descending by count and drops zero-count classes", () => {
    const items = computeProblems(
      stats({
        summary: {
          uptime_seconds: 0,
          connections_total: 0,
          connections_bad_total: 0,
          handshake_timeouts_total: 0,
          configured_users: 0,
          connections_bad_by_class: [
            { class: "rate_limited", total: 2 },
            { class: "quota_exceeded", total: 9 },
            { class: "unused", total: 0 },
          ],
        },
      }),
      [],
      [],
      null,
      s,
    );
    expect(items.map((i) => i.key)).toEqual(["connections_bad_quota_exceeded", "connections_bad_rate_limited"]);
  });

  it("orders: not_ready, read_only, stale topics, handshake failures, bad-connections scalars, bad-by-class, capabilities", () => {
    const items = computeProblems(
      stats({
        ready: { ready: false, status: "not_ready", admission_open: false, healthy_upstreams: 0, total_upstreams: 1 },
        health: { status: "degraded", read_only: true },
        summary: {
          uptime_seconds: 0,
          connections_total: 0,
          connections_bad_total: 3,
          handshake_timeouts_total: 1,
          configured_users: 0,
          handshake_failures_by_class: [{ class: "timeout", total: 1 }],
          connections_bad_by_class: [{ class: "rate_limited", total: 1 }],
        },
      }),
      [{ topic: "runtime", stale: true, error: null }],
      ["runtime_edge"],
      null,
      s,
    );
    expect(items.map((i) => i.key)).toEqual([
      "not_ready",
      "read_only",
      "stale_runtime",
      "handshake_timeout",
      "connections_bad_total",
      "handshake_timeouts_total",
      "connections_bad_rate_limited",
      "cap_runtime_edge",
    ]);
  });
});

describe("computeProblems — middle-proxy health", () => {
  it("does nothing when middle_proxy_enabled is false (deliberately direct)", () => {
    const dcs = dcsData([mkDc({ alive_writers: 0, floor_min: 2 })], { middle_proxy_enabled: false });
    expect(computeProblems(stats(), [], [], dcs, s)).toEqual([]);
  });

  it("does nothing when the dcs topic hasn't loaded yet", () => {
    expect(computeProblems(stats(), [], [], null, s)).toEqual([]);
  });

  it("reports me_direct_fallback as an error when every DC has 0 alive writers", () => {
    const dcs = dcsData([
      mkDc({ dc: 1, alive_writers: 0, floor_min: 2, required_writers: 2, coverage_pct: 0 }),
      mkDc({ dc: 2, alive_writers: 0, floor_min: 2, required_writers: 2, coverage_pct: 0 }),
    ]);
    const items = computeProblems(stats(), [], [], dcs, s);
    expect(items).toEqual([
      {
        key: "me_direct_fallback",
        label: "Middle-proxy недоступен: трафик идёт напрямую (0 живых writer'ов)",
        detail: "2",
        hint: "Проверьте исходящий доступ к Telegram / core.telegram.org (загрузка proxy-config).",
      },
    ]);
    expect(problemSeverity("me_direct_fallback")).toBe("error");
  });

  it("does not also report per-DC coverage gaps during a full fallback", () => {
    const dcs = dcsData([mkDc({ dc: 1, alive_writers: 0, floor_min: 1 })]);
    const items = computeProblems(stats(), [], [], dcs, s);
    expect(items.map((i) => i.key)).toEqual(["me_direct_fallback"]);
  });

  it("reports me_coverage_low per affected DC, worst coverage first, when not a full fallback", () => {
    const dcs = dcsData([
      mkDc({ dc: 1, alive_writers: 3, floor_min: 2, required_writers: 3, coverage_pct: 100 }), // healthy
      mkDc({ dc: 2, alive_writers: 1, floor_min: 2, required_writers: 2, coverage_pct: 50 }), // below floor_min
      mkDc({ dc: 3, alive_writers: 2, floor_min: 2, required_writers: 3, coverage_pct: 66.7 }), // coverage < 100
    ]);
    const items = computeProblems(stats(), [], [], dcs, s);
    expect(items.map((i) => i.key)).toEqual(["me_coverage_low_2", "me_coverage_low_3"]);
    expect(items[0].label).toBe("Низкое покрытие middle-proxy: DC 2");
    expect(items[0].detail).toBe("1/2 писателей, покрытие 50%");
    expect(problemSeverity("me_coverage_low_2")).toBe("warn");
  });

  it("reports me_split_traffic only when connections_summary is present and traffic is fully direct", () => {
    const dcs = dcsData([mkDc({ dc: 1, alive_writers: 2, floor_min: 2, required_writers: 2, coverage_pct: 100 })]);

    const withoutSummary = computeProblems(stats(), [], [], dcs, s);
    expect(withoutSummary).toEqual([]);

    const split = computeProblems(stats({ connections_summary: edgeTotals(0, 3) }), [], [], dcs, s);
    expect(split.map((i) => i.key)).toEqual(["me_split_traffic"]);
    expect(split[0].detail).toBe("3");
    expect(problemSeverity("me_split_traffic")).toBe("warn");

    const mixed = computeProblems(stats({ connections_summary: edgeTotals(2, 3) }), [], [], dcs, s);
    expect(mixed).toEqual([]);
  });

  it("reports nothing for a healthy middle-proxy snapshot", () => {
    const dcs = dcsData([mkDc({ dc: 2, alive_writers: 3, floor_min: 2, required_writers: 3, coverage_pct: 100 })]);
    const healthy = stats({ connections_summary: edgeTotals(5, 0) });
    expect(computeProblems(healthy, [], [], dcs, s)).toEqual([]);
  });

  it("matches the real-world direct-fallback snapshot from a live Telemt 3.5.2 instance", () => {
    // Field report: upstreams.dcs.middle_proxy_enabled true but every DC at
    // 0 alive_writers/coverage_pct/available_endpoints, and the edge totals
    // showing all traffic going direct — Telemt had logged "Startup
    // proxy-config unavailable … falling back to direct mode" at startup.
    const dcs = dcsData([
      mkDc({ dc: 1, endpoints: ["1.2.3.4:443"], available_endpoints: 0, required_writers: 2, floor_min: 2, alive_writers: 0, coverage_pct: 0 }),
      mkDc({ dc: 2, endpoints: ["5.6.7.8:443"], available_endpoints: 0, required_writers: 2, floor_min: 2, alive_writers: 0, coverage_pct: 0 }),
    ]);
    const liveStats = stats({ connections_summary: edgeTotals(0, 3) });
    const items = computeProblems(liveStats, [], [], dcs, s);
    expect(items.map((i) => i.key)).toEqual(["me_direct_fallback", "me_split_traffic"]);
  });
});

describe("problemSeverity", () => {
  it("ranks a not-ready proxy as an error and a capability gap as muted", () => {
    expect(problemSeverity("not_ready")).toBe("error");
    expect(problemSeverity("cap_runtime_edge")).toBe("muted");
  });

  it("treats every other problem as a warning", () => {
    expect(problemSeverity("read_only")).toBe("warn");
    expect(problemSeverity("stale_stats")).toBe("warn");
    expect(problemSeverity("handshake_tls")).toBe("warn");
  });
});
