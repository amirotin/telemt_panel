import { describe, expect, it } from "vitest";
import {
  computeProblems,
  counterDelta,
  isTlsProbeClass,
  problemDomain,
  lifetimeCountersNote,
  problemSeverity,
} from "./problems.helpers";
import type { DcStatus, DcStatusData, StatsSnapshot, StatsSummary } from "../../realtime/topics";
import { ru as s } from "../../i18n";

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { health: null, summary: null, ready: null, ...overrides };
}

// summary fills every StatsSummary scalar with a neutral zero so a test only
// states the counters it actually cares about.
function summary(overrides: Partial<StatsSummary> = {}): StatsSummary {
  return {
    uptime_seconds: 0,
    connections_total: 0,
    connections_bad_total: 0,
    handshake_timeouts_total: 0,
    configured_users: 0,
    ...overrides,
  };
}

// withSummary is the pair the rate rules need: the current snapshot plus the
// oldest one still inside the window (realtime/topicWindow.ts's baseline).
function withSummary(current: Partial<StatsSummary>, baseline: Partial<StatsSummary>) {
  return {
    current: stats({ summary: summary(current) }),
    baseline: stats({ summary: summary(baseline) }),
  };
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

  it("reports missing capabilities last", () => {
    const items = computeProblems(stats(), [], ["runtime_edge", "quota"], null, s);
    expect(items.map((i) => i.key)).toEqual(["cap_runtime_edge", "cap_quota"]);
  });

  it("does not treat a null summary (failed sub-call) as zero bad connections", () => {
    // stats() defaults summary to null — a distinct case from an explicit
    // summary object whose counters happen to be 0.
    expect(computeProblems(stats(), [], [], null, s)).toEqual([]);
  });

  it("orders: not_ready, read_only, stale topics, handshake failures, bad-connections scalars, bad-by-class, capabilities", () => {
    const { current, baseline } = withSummary(
      {
        connections_bad_total: 3,
        handshake_timeouts_total: 1,
        handshake_failures_by_class: [{ class: "timeout", total: 1 }],
        connections_bad_by_class: [{ class: "rate_limited", total: 1 }],
      },
      {},
    );
    const items = computeProblems(
      {
        ...current,
        ready: { ready: false, status: "not_ready", admission_open: false, healthy_upstreams: 0, total_upstreams: 1 },
        health: { status: "degraded", read_only: true },
      },
      [{ topic: "runtime", stale: true, error: null }],
      ["runtime_edge"],
      null,
      s,
      baseline,
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

describe("counterDelta", () => {
  it("is null without a baseline — 'unknown' is not 'unchanged'", () => {
    expect(counterDelta(undefined, 37_086)).toBeNull();
  });

  it("is the growth across the window", () => {
    expect(counterDelta(37_074, 37_086)).toBe(12);
    expect(counterDelta(37_086, 37_086)).toBe(0);
  });

  it("treats a counter reset as everything accumulated since it", () => {
    expect(counterDelta(37_086, 4)).toBe(4);
  });
});

describe("computeProblems — cumulative counters are ranked by rate, not by lifetime total", () => {
  it("reports nothing at all while the window holds fewer than two snapshots", () => {
    const { current } = withSummary(
      {
        connections_bad_total: 1_175,
        handshake_timeouts_total: 3_585,
        handshake_failures_by_class: [{ class: "unexpected_eof", total: 37_086 }],
      },
      {},
    );
    expect(computeProblems(current, [], [], null, s)).toEqual([]);
  });

  it("stays silent on the real VPS numbers when nothing moved in 15 minutes", () => {
    // Field report: Telemt 3.4.25, 20 days of uptime, 1.7M lifetime
    // connections. 37 086 unexpected_eof handshake failures, 1 175 bad
    // connections and 3 585 handshake timeouts are 20 days of internet
    // background scanning, not a problem happening now.
    const lifetime = {
      connections_bad_total: 1_175,
      handshake_timeouts_total: 3_585,
      handshake_failures_by_class: [{ class: "unexpected_eof", total: 37_086 }],
      connections_bad_by_class: [{ class: "rate_limited", total: 812 }],
    };
    const { current, baseline } = withSummary(lifetime, lifetime);
    expect(computeProblems(current, [], [], null, s, baseline)).toEqual([]);
  });

  it("warns with the delta, and keeps the lifetime total in the detail line, once a counter moves", () => {
    const { current, baseline } = withSummary(
      { handshake_failures_by_class: [{ class: "unexpected_eof", total: 37_098 }] },
      { handshake_failures_by_class: [{ class: "unexpected_eof", total: 37_086 }] },
    );
    const items = computeProblems(current, [], [], null, s, baseline);
    expect(items).toEqual([
      {
        key: "handshake_unexpected_eof",
        label: "Ошибки хендшейка: unexpected_eof",
        detail: "+12 за 15 мин · всего 37098",
      },
    ]);
    expect(problemSeverity("handshake_unexpected_eof")).toBe("warn");
  });

  it("ranks moving handshake-failure classes descending by lifetime total and drops the static ones", () => {
    const { current, baseline } = withSummary(
      {
        handshake_failures_by_class: [
          { class: "timeout", total: 3 },
          { class: "bad_secret", total: 10 },
          { class: "unexpected_eof", total: 37_086 },
        ],
      },
      {
        handshake_failures_by_class: [
          { class: "bad_secret", total: 4 },
          { class: "unexpected_eof", total: 37_086 },
        ],
      },
    );
    const items = computeProblems(current, [], [], null, s, baseline);
    // bad_secret grew by 6, timeout is a brand-new class (absent from the
    // baseline = a genuine zero) and grew by 3; unexpected_eof did not move.
    expect(items.map((i) => i.key)).toEqual(["handshake_bad_secret", "handshake_timeout"]);
    expect(items.map((i) => i.detail)).toEqual([
      "+6 за 15 мин · всего 10",
      "+3 за 15 мин · всего 3",
    ]);
  });

  it("reports the bad-connection scalars only for their growth", () => {
    const { current, baseline } = withSummary(
      { connections_bad_total: 1_179, handshake_timeouts_total: 3_585 },
      { connections_bad_total: 1_175, handshake_timeouts_total: 3_585 },
    );
    const items = computeProblems(current, [], [], null, s, baseline);
    expect(items.map((i) => i.key)).toEqual(["connections_bad_total"]);
    expect(items[0].detail).toBe("+4 за 15 мин · всего 1179");
  });

  it("ranks connections_bad_by_class by growth only", () => {
    const { current, baseline } = withSummary(
      {
        connections_bad_by_class: [
          { class: "rate_limited", total: 2 },
          { class: "quota_exceeded", total: 9 },
          { class: "unused", total: 0 },
        ],
      },
      { connections_bad_by_class: [{ class: "quota_exceeded", total: 8 }] },
    );
    const items = computeProblems(current, [], [], null, s, baseline);
    expect(items.map((i) => i.key)).toEqual([
      "connections_bad_quota_exceeded",
      "connections_bad_rate_limited",
    ]);
    expect(items.map((i) => i.detail)).toEqual([
      "+1 за 15 мин · всего 9",
      "+2 за 15 мин · всего 2",
    ]);
  });

  it("reports the post-reset counter after Telemt restarted mid-window", () => {
    const { current, baseline } = withSummary(
      { connections_bad_total: 6 },
      { connections_bad_total: 1_175 },
    );
    const items = computeProblems(current, [], [], null, s, baseline);
    expect(items.map((i) => i.key)).toEqual(["connections_bad_total"]);
    expect(items[0].detail).toBe("+6 за 15 мин · всего 6");
  });

  it("stays silent when the baseline snapshot had no summary of its own", () => {
    const { current } = withSummary({ connections_bad_total: 1_175 }, {});
    expect(computeProblems(current, [], [], null, s, stats())).toEqual([]);
  });
});

describe("lifetimeCountersNote", () => {
  it("is null without a summary or when every counter is genuinely zero", () => {
    expect(lifetimeCountersNote(null, s)).toBeNull();
    expect(lifetimeCountersNote(stats(), s)).toBeNull();
    expect(lifetimeCountersNote(stats({ summary: summary() }), s)).toBeNull();
  });

  it("names the non-zero lifetime counters and points at the Соединения page", () => {
    const note = lifetimeCountersNote(
      stats({
        summary: summary({
          connections_bad_total: 1_175,
          handshake_timeouts_total: 3_585,
          handshake_failures_by_class: [
            { class: "unexpected_eof", total: 37_086 },
            { class: "timeout", total: 14 },
          ],
        }),
      }),
      s,
    );
    expect(note).toBe(
      "Счётчики за всё время: Плохие соединения (всего) — 1175 · Таймауты хендшейка — 3585 · Ошибки хендшейка — 37100 (см. Соединения)",
    );
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

describe("TLS/probe anomalies as ONE problem item (concept §19)", () => {
  it("recognizes the classes Telemt names for wrong-protocol traffic", () => {
    expect(isTlsProbeClass("tls_handshake_bad_client")).toBe(true);
    expect(isTlsProbeClass("tls_mtproto_bad_client")).toBe(true);
    expect(isTlsProbeClass("probe_detected")).toBe(true);
    expect(isTlsProbeClass("direct_modes_disabled")).toBe(false);
    expect(isTlsProbeClass("rate_limited")).toBe(false);
  });

  it("folds every growing tls_* class into one row with the summed figures", () => {
    // The live VPS shape: two TLS classes plus one unrelated class.
    const { current, baseline } = withSummary(
      {
        connections_bad_by_class: [
          { class: "tls_handshake_bad_client", total: 1_012 },
          { class: "tls_mtproto_bad_client", total: 275 },
          { class: "direct_modes_disabled", total: 16 },
        ],
      },
      {
        connections_bad_by_class: [
          { class: "tls_handshake_bad_client", total: 950 },
          { class: "tls_mtproto_bad_client", total: 253 },
          { class: "direct_modes_disabled", total: 14 },
        ],
      },
    );
    const items = computeProblems(current, [], [], null, s, baseline);
    expect(items.map((i) => i.key)).toEqual([
      "tls_probe_anomaly",
      "connections_bad_direct_modes_disabled",
    ]);
    const tls = items[0];
    expect(tls.label).toBe("Подозрительные TLS-клиенты");
    // 62 + 22 grown, 1012 + 275 lifetime — one phenomenon, one row.
    expect(tls.detail).toBe("+84 за 15 мин · всего 1287");
    // Which classes it covers stays visible, quietly.
    expect(tls.hint).toBe("tls_handshake_bad_client · tls_mtproto_bad_client");
  });

  it("stays silent while the TLS classes are not growing", () => {
    const same = {
      connections_bad_by_class: [{ class: "tls_handshake_bad_client", total: 1_012 }],
    };
    const { current, baseline } = withSummary(same, same);
    expect(computeProblems(current, [], [], null, s, baseline)).toEqual([]);
  });
});

describe("problemDomain — every row that has a cause is a way into Пульс", () => {
  it("sends counter rows to Счётчики and the TLS row to Безопасность", () => {
    expect(problemDomain("handshake_unexpected_eof")).toBe("counters");
    expect(problemDomain("connections_bad_total")).toBe("counters");
    expect(problemDomain("connections_bad_rate_limited")).toBe("counters");
    expect(problemDomain("handshake_timeouts_total")).toBe("counters");
    expect(problemDomain("tls_probe_anomaly")).toBe("security");
  });

  it("sends the middle-proxy rows to the page that shows writers", () => {
    expect(problemDomain("me_direct_fallback")).toBe("dc");
    expect(problemDomain("me_coverage_low_2")).toBe("dc");
    expect(problemDomain("me_split_traffic")).toBe("me");
  });

  it("sends a stale topic to the page that would have shown it", () => {
    expect(problemDomain("stale_stats")).toBe("connections");
    expect(problemDomain("stale_runtime")).toBe("me");
    expect(problemDomain("stale_upstreams")).toBe("upstreams");
    expect(problemDomain("stale_security")).toBe("security");
  });

  // Facts about the whole install: no single page owns them, and guessing
  // one would send the reader somewhere that explains nothing.
  it("has no page for the install-wide states", () => {
    expect(problemDomain("not_ready")).toBeUndefined();
    expect(problemDomain("read_only")).toBeUndefined();
    expect(problemDomain("cap_quota")).toBeUndefined();
  });
});
