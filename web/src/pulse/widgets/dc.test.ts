import { describe, expect, it } from "vitest";
import {
  DC_RTT_WARN_MS,
  computeDc,
  dcBoardRows,
  dcCoverageState,
  dcNodeAriaLabel,
  dcNodeTone,
  dcRttText,
  dcRttTone,
  dcWriterDots,
  isTestDc,
} from "./dc.helpers";
import type { DcStatus } from "../../realtime/topics";
import { en, ru } from "../../i18n";

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

// Concept §9: the card stays dark and the RING carries the state, with the
// test sites drawn quieter — but never quiet enough to hide a real fault.
describe("dcNodeTone", () => {
  it("is ok for a healthy production data center", () => {
    expect(dcNodeTone(dc({ dc: 4 }))).toBe("ok");
  });

  it("is muted for a healthy test site", () => {
    expect(dcNodeTone(dc({ dc: -4 }))).toBe("muted");
  });

  it("still warns on a degraded test site", () => {
    expect(dcNodeTone(dc({ dc: -4, alive_writers: 1, coverage_pct: 50 }))).toBe("warn");
  });

  it("still errors on a test site with no writers", () => {
    expect(dcNodeTone(dc({ dc: -4, alive_writers: 0, coverage_pct: 0 }))).toBe("error");
  });

  it("calls the negative ids the test sites", () => {
    expect(isTestDc({ dc: -203 })).toBe(true);
    expect(isTestDc({ dc: 203 })).toBe(false);
  });
});

describe("dcRttTone", () => {
  it("has no tone for an unmeasured RTT", () => {
    expect(dcRttTone(null)).toBeNull();
  });

  it("is neutral at or below the threshold", () => {
    expect(dcRttTone(DC_RTT_WARN_MS)).toBeNull();
    expect(dcRttTone(32)).toBeNull();
  });

  it("is amber above the threshold", () => {
    expect(dcRttTone(DC_RTT_WARN_MS + 0.5)).toBe("warn");
    expect(dcRttTone(187)).toBe("warn");
  });
});

describe("dcWriterDots", () => {
  it("draws one dot per required writer, filled up to the alive count", () => {
    expect(dcWriterDots(dc({ required_writers: 3, alive_writers: 2 }))).toEqual([true, true, false]);
  });

  it("fills every dot at full coverage", () => {
    expect(dcWriterDots(dc({ required_writers: 3, alive_writers: 3 }))).toEqual([true, true, true]);
  });

  it("draws no dots when the floor is too high to count at a glance", () => {
    expect(dcWriterDots(dc({ required_writers: 10, alive_writers: 10 }))).toBeNull();
  });

  it("draws no dots when nothing is required", () => {
    expect(dcWriterDots(dc({ required_writers: 0, alive_writers: 0 }))).toBeNull();
  });
});

// Concept §9's «Альтернативная компоновка», exactly:
//   DC-5  DC-4  DC-3  DC-2  DC-1  DC-203
//   DC1   DC2   DC3   DC4   DC5   DC203
describe("dcBoardRows", () => {
  const live = [-203, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 203].map((id) => ({ dc: id }));

  it("puts the negative ids on the first row and the positive ones on the second", () => {
    const rows = dcBoardRows(live);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.map((d) => d.dc)).toEqual([-5, -4, -3, -2, -1, -203]);
    expect(rows[1]!.map((d) => d.dc)).toEqual([1, 2, 3, 4, 5, 203]);
  });

  it("pairs each column with the data center facing it", () => {
    const [negative, positive] = dcBoardRows(live);
    expect(negative!.length).toBe(positive!.length);
    // Column six is the 203-family pair; the closing slot on both rows.
    expect(negative!.at(-1)!.dc).toBe(-203);
    expect(positive!.at(-1)!.dc).toBe(203);
  });

  it("does not depend on the payload's own order", () => {
    const shuffled = [...live].reverse();
    expect(dcBoardRows(shuffled).map((row) => row.map((d) => d.dc))).toEqual(
      dcBoardRows(live).map((row) => row.map((d) => d.dc)),
    );
  });

  it("omits a row that has no data centers", () => {
    expect(dcBoardRows([{ dc: 1 }, { dc: 2 }]).map((r) => r.map((d) => d.dc))).toEqual([[1, 2]]);
  });

  it("keeps every data center exactly once", () => {
    const flat = dcBoardRows(live).flat();
    expect(flat).toHaveLength(live.length);
    expect(new Set(flat.map((d) => d.dc)).size).toBe(live.length);
  });
});

describe("dcRttText", () => {
  it("rounds to whole milliseconds", () => {
    expect(dcRttText(dc({ rtt_ms: 41.6 }), en)).toBe("42 ms");
  });

  it("is an em dash when nothing measured it", () => {
    expect(dcRttText(dc({ rtt_ms: null }), en)).toBe("—");
  });
});

describe("dcNodeAriaLabel", () => {
  it("names all four facts the node draws", () => {
    const label = dcNodeAriaLabel(dc({ dc: 4, required_writers: 3, alive_writers: 2, coverage_pct: 67, rtt_ms: 33 }), en);
    expect(label).toContain("DC 4");
    expect(label).toContain("coverage 67");
    expect(label).toContain("writers 2 of 3");
    expect(label).toContain("33 ms");
  });

  it("says a test site is one, since only the muted ring shows it", () => {
    expect(dcNodeAriaLabel(dc({ dc: -4 }), ru)).toContain(ru.pulse.dc.testSite);
    expect(dcNodeAriaLabel(dc({ dc: 4 }), ru)).not.toContain(ru.pulse.dc.testSite);
  });
});
