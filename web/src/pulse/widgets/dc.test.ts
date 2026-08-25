import { describe, expect, it } from "vitest";
import { computeDc, dcCoverageState } from "./dc.helpers";
import type { DcStatus } from "../../realtime/topics";

function dc(overrides: Partial<DcStatus> = {}): DcStatus {
  return {
    dc: 2,
    endpoints: [],
    endpoint_writers: [],
    available_endpoints: 1,
    available_pct: 100,
    required_writers: 2,
    floor_min: 1,
    floor_target: 2,
    floor_max: 3,
    floor_capped: false,
    alive_writers: 2,
    coverage_pct: 100,
    fresh_alive_writers: 2,
    fresh_coverage_pct: 100,
    rtt_ms: null,
    load: 0,
    ...overrides,
  };
}

describe("computeDc", () => {
  it("is loading when the topic hasn't loaded", () => {
    expect(computeDc(null)).toEqual({ status: "loading" });
  });

  it("is disabled with the wire reason when middle_proxy_enabled is false", () => {
    expect(computeDc({ middle_proxy_enabled: false, reason: "no upstreams", dcs: [] })).toEqual({
      status: "disabled",
      reason: "no upstreams",
    });
  });

  it("is ok with the dc list when enabled", () => {
    const rows = [dc()];
    expect(computeDc({ middle_proxy_enabled: true, dcs: rows })).toEqual({ status: "ok", dcs: rows });
  });
});

describe("dcCoverageState", () => {
  it("is error when there are no alive writers at all", () => {
    expect(dcCoverageState(dc({ alive_writers: 0, coverage_pct: 0 }))).toBe("error");
  });
  it("is warn when coverage is under 100% but some writers are alive", () => {
    expect(dcCoverageState(dc({ alive_writers: 1, coverage_pct: 50 }))).toBe("warn");
  });
  it("is ok at full coverage", () => {
    expect(dcCoverageState(dc({ alive_writers: 2, coverage_pct: 100 }))).toBe("ok");
  });
});
