import { describe, expect, it } from "vitest";
import { upstreamsGroups } from "./upstreams.helpers";
import type { UpstreamsData } from "../../realtime/topics";

function zero(): UpstreamsData["zero"] {
  return {
    connect_attempt_total: 1,
    connect_success_total: 1,
    connect_fail_total: 0,
    connect_failfast_hard_error_total: 0,
    connect_attempts_bucket_1: 1,
    connect_attempts_bucket_2: 0,
    connect_attempts_bucket_3_4: 0,
    connect_attempts_bucket_gt_4: 0,
    connect_duration_success_bucket_le_100ms: 1,
    connect_duration_success_bucket_101_500ms: 0,
    connect_duration_success_bucket_501_1000ms: 0,
    connect_duration_success_bucket_gt_1000ms: 0,
    connect_duration_fail_bucket_le_100ms: 0,
    connect_duration_fail_bucket_101_500ms: 0,
    connect_duration_fail_bucket_501_1000ms: 0,
    connect_duration_fail_bucket_gt_1000ms: 0,
  };
}

describe("upstreamsGroups", () => {
  it("emits summary, zero-counters, then one group per upstream", () => {
    const data: UpstreamsData = {
      enabled: true,
      generated_at_epoch_secs: 0,
      zero: zero(),
      summary: { configured_total: 1, healthy_total: 1, unhealthy_total: 0, direct_total: 1, socks4_total: 0, socks5_total: 0, shadowsocks_total: 0 },
      upstreams: [{ upstream_id: 7, route_kind: "direct", address: "1.2.3.4:443", weight: 1, scopes: "all", healthy: true, fails: 0, last_check_age_secs: 1, effective_latency_ms: 5, dc: [] }],
    };
    const groups = upstreamsGroups(data);
    expect(groups.map((g) => g.title)).toEqual(["Сводка", "Счётчики подключений", "Апстримы #7"]);
  });

  it("omits the per-upstream groups when upstreams is absent", () => {
    const data: UpstreamsData = { enabled: true, generated_at_epoch_secs: 0, zero: zero() };
    const groups = upstreamsGroups(data);
    expect(groups.map((g) => g.title)).toEqual(["Счётчики подключений"]);
  });

  it("omits the summary group when summary is absent", () => {
    const data: UpstreamsData = { enabled: true, generated_at_epoch_secs: 0, zero: zero(), upstreams: [] };
    const groups = upstreamsGroups(data);
    expect(groups.find((g) => g.title === "Сводка")).toBeUndefined();
  });
});
