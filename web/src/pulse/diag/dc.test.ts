import { describe, expect, it } from "vitest";
import { dcGroups } from "./dc.helpers";
import type { DcStatus } from "../../realtime/topics";

function dc(overrides: Partial<DcStatus> = {}): DcStatus {
  return {
    dc: 2,
    endpoints: ["1.2.3.4:443"],
    endpoint_writers: [{ endpoint: "1.2.3.4:443", active_writers: 3 }],
    available_endpoints: 1,
    available_pct: 100,
    required_writers: 3,
    floor_min: 1,
    floor_target: 3,
    floor_max: 5,
    floor_capped: false,
    alive_writers: 3,
    coverage_pct: 100,
    fresh_alive_writers: 3,
    fresh_coverage_pct: 100,
    rtt_ms: 12.5,
    load: 4,
    ...overrides,
  };
}

describe("dcGroups", () => {
  it("returns one group per DC, titled 'DC <id>'", () => {
    const groups = dcGroups([dc({ dc: 2 }), dc({ dc: 4 })]);
    expect(groups.map((g) => g.title)).toEqual(["DC 2", "DC 4"]);
  });

  it("flattens every field of the DC, including nested endpoint_writers", () => {
    const groups = dcGroups([dc()]);
    const keys = groups[0].rows.map((r) => r.key);
    expect(keys).toContain("coverage_pct");
    expect(keys).toContain("endpoint_writers[0].endpoint");
    expect(keys).toContain("endpoint_writers[0].active_writers");
  });

  it("returns no groups for an empty list", () => {
    expect(dcGroups([])).toEqual([]);
  });

  it("returns no groups for a null list (nil Go slice on the wire)", () => {
    expect(dcGroups(null)).toEqual([]);
  });
});
