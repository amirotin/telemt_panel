import { describe, expect, it } from "vitest";
import {
  computeUpstreams,
  computeUpstreamsCard,
  upstreamMeanLatency,
  upstreamQualitySuccessRate,
} from "./upstreams.helpers";
import type {
  RuntimeUpstreamQualityData,
  UpstreamStatus,
  UpstreamSummary,
  UpstreamsData,
} from "../../realtime/topics";

function upstream(overrides: Partial<UpstreamStatus> = {}): UpstreamStatus {
  return {
    upstream_id: 1,
    route_kind: "direct",
    address: "1.2.3.4:443",
    weight: 1,
    scopes: "all",
    healthy: true,
    fails: 0,
    last_check_age_secs: 1,
    effective_latency_ms: 10,
    dc: [],
    ...overrides,
  };
}

describe("computeUpstreams", () => {
  it("is loading when the topic hasn't loaded", () => {
    expect(computeUpstreams(null)).toEqual({ status: "loading" });
  });

  it("is disabled with the wire reason", () => {
    expect(computeUpstreams({ enabled: false, reason: "no upstreams configured" })).toEqual({
      status: "disabled",
      reason: "no upstreams configured",
    });
  });

  it("uses the summary's healthy/unhealthy totals when present", () => {
    const view = computeUpstreams({
      enabled: true,
      summary: { healthy_total: 3, unhealthy_total: 1 },
      upstreams: [upstream()],
    });
    expect(view).toEqual({ status: "ok", upstreams: [upstream()], healthyTotal: 3, unhealthyTotal: 1 });
  });

  it("derives healthy/unhealthy totals from the list when summary is absent", () => {
    const view = computeUpstreams({ enabled: true, upstreams: [upstream(), upstream({ healthy: false })] });
    expect(view.status).toBe("ok");
    if (view.status === "ok") {
      expect(view.healthyTotal).toBe(1);
      expect(view.unhealthyTotal).toBe(1);
    }
  });

  it("defaults to an empty list when upstreams is absent", () => {
    const view = computeUpstreams({ enabled: true });
    expect(view).toEqual({ status: "ok", upstreams: [], healthyTotal: 0, unhealthyTotal: 0 });
  });
});

function quality(overrides: Partial<RuntimeUpstreamQualityData> = {}): RuntimeUpstreamQualityData {
  return {
    enabled: true,
    generated_at_epoch_secs: 0,
    policy: { connect_retry_attempts: 3, connect_retry_backoff_ms: 100, connect_budget_ms: 5000, unhealthy_fail_threshold: 3, connect_failfast_hard_errors: true },
    counters: { connect_attempt_total: 10, connect_success_total: 9, connect_fail_total: 1, connect_failfast_hard_error_total: 0 },
    ...overrides,
  };
}

describe("upstreamQualitySuccessRate", () => {
  it("is null when quality is absent or disabled", () => {
    expect(upstreamQualitySuccessRate(null)).toBeNull();
    expect(upstreamQualitySuccessRate(undefined)).toBeNull();
    expect(upstreamQualitySuccessRate(quality({ enabled: false }))).toBeNull();
  });

  it("is null when there have been no connect attempts (avoids a misleading 0%)", () => {
    expect(
      upstreamQualitySuccessRate(quality({ counters: { connect_attempt_total: 0, connect_success_total: 0, connect_fail_total: 0, connect_failfast_hard_error_total: 0 } })),
    ).toBeNull();
  });

  it("computes a rounded success percentage", () => {
    expect(upstreamQualitySuccessRate(quality())).toBe(90);
    expect(
      upstreamQualitySuccessRate(quality({ counters: { connect_attempt_total: 3, connect_success_total: 1, connect_fail_total: 2, connect_failfast_hard_error_total: 0 } })),
    ).toBe(33);
  });
});

// Concept §12: one card that says what the operator HAS. The direct-only
// fixture is the live VPS's own payload (GET /v1/stats/upstreams,
// 2026-08-30); the mixed one is built from the same SDK types, since no
// install this panel has met has a second route.
function data(overrides: Partial<UpstreamsData> = {}): UpstreamsData {
  return {
    enabled: true,
    generated_at_epoch_secs: 1_788_090_419,
    zero: {
      connect_attempt_total: 0,
      connect_success_total: 0,
      connect_fail_total: 0,
      connect_failfast_hard_error_total: 0,
      connect_attempts_bucket_1: 0,
      connect_attempts_bucket_2: 0,
      connect_attempts_bucket_3_4: 0,
      connect_attempts_bucket_gt_4: 0,
      connect_duration_success_bucket_le_100ms: 0,
      connect_duration_success_bucket_101_500ms: 0,
      connect_duration_success_bucket_501_1000ms: 0,
      connect_duration_success_bucket_gt_1000ms: 0,
      connect_duration_fail_bucket_le_100ms: 0,
      connect_duration_fail_bucket_101_500ms: 0,
      connect_duration_fail_bucket_501_1000ms: 0,
      connect_duration_fail_bucket_gt_1000ms: 0,
    },
    ...overrides,
  };
}

function summary(overrides: Partial<UpstreamSummary> = {}): UpstreamSummary {
  return {
    configured_total: 1,
    healthy_total: 1,
    unhealthy_total: 0,
    direct_total: 1,
    socks4_total: 0,
    socks5_total: 0,
    shadowsocks_total: 0,
    ...overrides,
  };
}

function card(payload: UpstreamsData) {
  const result = computeUpstreams(payload);
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return computeUpstreamsCard(result, payload);
}

describe("computeUpstreamsCard", () => {
  it("reads the live direct-only fleet as §12's minimal card", () => {
    const view = card(
      data({
        summary: summary(),
        upstreams: [
          upstream({ upstream_id: 0, address: "direct", effective_latency_ms: 102.789 }),
        ],
      }),
    );
    expect(view).toEqual({
      directOnly: true,
      healthy: 1,
      total: 1,
      tone: "ok",
      kinds: [{ label: "Direct", count: 1 }],
      latencyMs: 102.789,
    });
  });

  it("grows the composition on its own when a fleet has more than direct", () => {
    const view = card(
      data({
        summary: summary({ configured_total: 3, healthy_total: 3, socks5_total: 2 }),
        upstreams: [
          upstream({ upstream_id: 0, address: "direct", effective_latency_ms: 28 }),
          upstream({ upstream_id: 1, route_kind: "socks5", effective_latency_ms: 34 }),
          upstream({ upstream_id: 2, route_kind: "socks5", effective_latency_ms: 34 }),
        ],
      }),
    );
    expect(view.directOnly).toBe(false);
    expect(view.kinds).toEqual([
      { label: "Direct", count: 1 },
      { label: "SOCKS5", count: 2 },
    ]);
    expect(view.healthy).toBe(3);
    expect(view.total).toBe(3);
    expect(view.tone).toBe("ok");
    expect(view.latencyMs).toBeCloseTo(32);
  });

  it("turns the fraction loud the moment one route stops answering", () => {
    const view = card(
      data({
        summary: summary({ configured_total: 3, healthy_total: 2, unhealthy_total: 1, socks5_total: 2 }),
        upstreams: [
          upstream({ upstream_id: 0, address: "direct" }),
          upstream({ upstream_id: 1, route_kind: "socks5" }),
          upstream({ upstream_id: 2, route_kind: "socks5", healthy: false }),
        ],
      }),
    );
    expect(view).toMatchObject({ healthy: 2, total: 3, tone: "error", directOnly: false });
  });

  it("does not call a single unhealthy direct route healthy", () => {
    const view = card(
      data({
        summary: summary({ healthy_total: 0, unhealthy_total: 1 }),
        upstreams: [upstream({ upstream_id: 0, address: "direct", healthy: false })],
      }),
    );
    expect(view).toMatchObject({ directOnly: true, tone: "error", healthy: 0, total: 1 });
  });

  it("counts route kinds off the rows when the payload carried no summary", () => {
    const view = card(
      data({
        upstreams: [
          upstream({ upstream_id: 1, route_kind: "socks5" }),
          upstream({ upstream_id: 2, route_kind: "socks5" }),
        ],
      }),
    );
    expect(view.kinds).toEqual([{ label: "socks5", count: 2 }]);
    expect(view.directOnly).toBe(false);
  });

  it("has no latency to average when nothing has been measured", () => {
    const view = card(
      data({
        summary: summary(),
        upstreams: [upstream({ upstream_id: 0, address: "direct", effective_latency_ms: null })],
      }),
    );
    expect(view.latencyMs).toBeNull();
  });

  it("averages only the routes that reported a latency", () => {
    expect(
      upstreamMeanLatency([
        upstream({ effective_latency_ms: 20 }),
        upstream({ effective_latency_ms: null }),
        upstream({ effective_latency_ms: 40 }),
      ]),
    ).toBe(30);
    expect(upstreamMeanLatency([])).toBeNull();
  });
});
