import { describe, expect, it } from "vitest";
import { computeUpstreams } from "./upstreams.helpers";
import type { UpstreamStatus } from "../../realtime/topics";

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
