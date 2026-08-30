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
  dcKindLabel,
  dcWriterRatio,
  isMediaDc,
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

// Concept §9: the card stays dark and the RING carries the state — every
// node, media groups included. Nothing on this board is drawn quieter for
// being a negative id.
describe("dcNodeTone", () => {
  it("is ok for a healthy data center", () => {
    expect(dcNodeTone(dc({ dc: 4 }))).toBe("ok");
  });

  it("is ok — not muted — for a healthy media group", () => {
    expect(dcNodeTone(dc({ dc: -4 }))).toBe("ok");
  });

  it("is ok for the healthy test site too", () => {
    expect(dcNodeTone(dc({ dc: 203 }))).toBe("ok");
    expect(dcNodeTone(dc({ dc: -203 }))).toBe("ok");
  });

  it("warns on a degraded media group", () => {
    expect(dcNodeTone(dc({ dc: -4, alive_writers: 1, coverage_pct: 50 }))).toBe("warn");
  });

  it("errors on a media group with no writers", () => {
    expect(dcNodeTone(dc({ dc: -4, alive_writers: 0, coverage_pct: 0 }))).toBe("error");
  });
});

// The correction owner and Telemt agree (transport/middle_proxy/
// pool_config.rs): DC −N is the media-server group of DC N, and the test
// environment is 203 — not "every negative id".
describe("what a DC id means", () => {
  it("reads a negative id as a media group, not a test site", () => {
    expect(isMediaDc({ dc: -1 })).toBe(true);
    expect(isTestDc({ dc: -1 })).toBe(false);
    expect(isMediaDc({ dc: 1 })).toBe(false);
    expect(isTestDc({ dc: 1 })).toBe(false);
  });

  it("reads 203 and −203 as the test site and its media group", () => {
    expect(isTestDc({ dc: 203 })).toBe(true);
    expect(isMediaDc({ dc: 203 })).toBe(false);
    expect(isTestDc({ dc: -203 })).toBe(true);
    expect(isMediaDc({ dc: -203 })).toBe(true);
  });

  it("labels the four ids the way the board and the rail must", () => {
    expect(dcKindLabel({ dc: 1 }, ru)).toBeNull();
    expect(dcKindLabel({ dc: -1 }, ru)).toBe("медиа-серверы DC 1");
    expect(dcKindLabel({ dc: 203 }, ru)).toBe(ru.pulse.dc.testSite);
    expect(dcKindLabel({ dc: -203 }, ru)).toBe(
      `медиа-серверы DC 203 · ${ru.pulse.dc.testSite}`,
    );
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

describe("dcWriterRatio", () => {
  it("is the live share of the floor", () => {
    expect(dcWriterRatio({ required_writers: 4, alive_writers: 3 })).toBe(0.75);
  });

  it("is a full bar at the floor", () => {
    expect(dcWriterRatio({ required_writers: 3, alive_writers: 3 })).toBe(1);
  });

  it("reads the same way at any floor — including the one that broke the dots", () => {
    expect(dcWriterRatio({ required_writers: 10, alive_writers: 9 })).toBe(0.9);
    expect(dcWriterRatio({ required_writers: 10, alive_writers: 10 })).toBe(1);
  });

  it("clamps a pool running over its floor", () => {
    expect(dcWriterRatio({ required_writers: 3, alive_writers: 5 })).toBe(1);
  });

  it("is empty when nothing is alive, full when nothing is required", () => {
    expect(dcWriterRatio({ required_writers: 3, alive_writers: 0 })).toBe(0);
    expect(dcWriterRatio({ required_writers: 0, alive_writers: 0 })).toBe(0);
    expect(dcWriterRatio({ required_writers: 0, alive_writers: 2 })).toBe(1);
  });
});

// Concept §9's «Альтернативная компоновка», exactly:
//   Медиа      DC-5  DC-4  DC-3  DC-2  DC-1  DC-203
//   Основные   DC1   DC2   DC3   DC4   DC5   DC203
describe("dcBoardRows", () => {
  const live = [-203, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 203].map((id) => ({ dc: id }));

  it("puts the media groups on the first row and the main ones on the second", () => {
    const rows = dcBoardRows(live);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.kind)).toEqual(["media", "main"]);
    expect(rows[0]!.dcs.map((d) => d.dc)).toEqual([-5, -4, -3, -2, -1, -203]);
    expect(rows[1]!.dcs.map((d) => d.dc)).toEqual([1, 2, 3, 4, 5, 203]);
  });

  it("pairs each column with the data center facing it", () => {
    const [media, main] = dcBoardRows(live);
    expect(media!.dcs.length).toBe(main!.dcs.length);
    // Column six is the 203-family pair; the closing slot on both rows.
    expect(media!.dcs.at(-1)!.dc).toBe(-203);
    expect(main!.dcs.at(-1)!.dc).toBe(203);
  });

  it("does not depend on the payload's own order", () => {
    const shuffled = [...live].reverse();
    expect(dcBoardRows(shuffled).map((row) => row.dcs.map((d) => d.dc))).toEqual(
      dcBoardRows(live).map((row) => row.dcs.map((d) => d.dc)),
    );
  });

  it("omits a row that has no data centers", () => {
    const rows = dcBoardRows([{ dc: 1 }, { dc: 2 }]);
    expect(rows.map((r) => r.kind)).toEqual(["main"]);
    expect(rows.map((r) => r.dcs.map((d) => d.dc))).toEqual([[1, 2]]);
  });

  it("keeps every data center exactly once", () => {
    const flat = dcBoardRows(live).flatMap((row) => row.dcs);
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

  it("names the group kind, which only a dashed ring and a tag hint at", () => {
    expect(dcNodeAriaLabel(dc({ dc: -4 }), ru)).toContain("медиа-серверы DC 4");
    expect(dcNodeAriaLabel(dc({ dc: 203 }), ru)).toContain(ru.pulse.dc.testSite);
    expect(dcNodeAriaLabel(dc({ dc: 4 }), ru)).not.toContain(ru.pulse.dc.testSite);
    expect(dcNodeAriaLabel(dc({ dc: 4 }), ru)).not.toContain("медиа-серверы");
  });
});
