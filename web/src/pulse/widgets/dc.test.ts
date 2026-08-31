import { describe, expect, it } from "vitest";
import {
  DC_RTT_WARN_MS,
  computeDc,
  computeDcOverview,
  dcCoverageState,
  dcNodeAriaLabel,
  dcNodeTone,
  dcRttText,
  dcRttTone,
  dcRouteState,
  dcRouteGroups,
  dcKindLabel,
  isMediaDc,
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

describe("dcRouteState", () => {
  it("is healthy at full visible writer coverage", () => {
    expect(dcRouteState(dc({ available_pct: 100, coverage_pct: 100 }))).toBe("ok");
  });

  it("does not turn a hidden endpoint signal into an unexplained overview warning", () => {
    expect(dcRouteState(dc({ available_pct: 70, coverage_pct: 100 }))).toBe("ok");
  });

  it("leaves fresh coverage to Problems and the detail page", () => {
    expect(dcRouteState(dc({ coverage_pct: 100, fresh_coverage_pct: 75 }))).toBe("ok");
  });

  it("marks high RTT as attention without calling coverage degraded", () => {
    expect(dcRouteState(dc({ rtt_ms: DC_RTT_WARN_MS + 1 }))).toBe("warn");
  });

  it("does not hide a healthy coverage reading behind endpoint availability", () => {
    expect(dcRouteState(dc({ available_pct: 0, coverage_pct: 100 }))).toBe("ok");
  });

  it("keeps a route with no writers in the error state", () => {
    expect(dcRouteState(dc({ alive_writers: 0, coverage_pct: 0, available_pct: 0 }))).toBe("error");
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

  it("is ok for the healthy 203 data centers too", () => {
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

// MTProxy's signed target convention: −N is the media-only route of DC N.
describe("what a DC id means", () => {
  it("reads a negative id as a media group", () => {
    expect(isMediaDc({ dc: -1 })).toBe(true);
    expect(isMediaDc({ dc: 1 })).toBe(false);
  });

  it("reads 203 and −203 as a main DC and its media group", () => {
    expect(isMediaDc({ dc: 203 })).toBe(false);
    expect(isMediaDc({ dc: -203 })).toBe(true);
  });

  it("labels the four ids the way the board and the rail must", () => {
    expect(dcKindLabel({ dc: 1 }, ru)).toBeNull();
    expect(dcKindLabel({ dc: -1 }, ru)).toBe("медиа-маршрут DC 1");
    expect(dcKindLabel({ dc: 203 }, ru)).toBeNull();
    expect(dcKindLabel({ dc: -203 }, ru)).toBe("медиа-маршрут DC 203");
  });
});

describe("computeDcOverview", () => {
  it("summarizes all production data centers, including the 203 pair", () => {
    const dcs = [-203, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 203].map((id, index) =>
      dc({ dc: id, rtt_ms: 20 + index }),
    );
    expect(computeDcOverview(dcs)).toMatchObject({
      total: 12,
      covered: 12,
      writersAlive: 24,
      writersRequired: 24,
      p95RttMs: 31,
      attention: [],
    });
  });

  it("ranks failed coverage ahead of degraded coverage and high RTT", () => {
    const failed = dc({ dc: 3, alive_writers: 0, coverage_pct: 0, rtt_ms: 10 });
    const degraded = dc({ dc: -2, alive_writers: 1, coverage_pct: 50, rtt_ms: 30 });
    const slow = dc({ dc: 203, rtt_ms: DC_RTT_WARN_MS + 1 });
    const view = computeDcOverview([slow, degraded, failed]);
    expect(view.covered).toBe(1);
    expect(view.attention.map((item) => item.dc)).toEqual([3, -2, 203]);
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

describe("dcRouteGroups", () => {
  const live = [-203, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 203].map((id) => ({ dc: id }));

  it("pairs the main and media routes under six logical DC ids", () => {
    const groups = dcRouteGroups(live);
    expect(groups.map((group) => group.id)).toEqual([1, 2, 3, 4, 5, 203]);
    expect(groups.map((group) => [group.main?.dc, group.media?.dc])).toEqual([
      [1, -1],
      [2, -2],
      [3, -3],
      [4, -4],
      [5, -5],
      [203, -203],
    ]);
  });

  it("does not depend on the payload's own order", () => {
    const shape = (rows: typeof live) =>
      dcRouteGroups(rows).map((group) => [group.id, group.main?.dc, group.media?.dc]);
    expect(shape([...live].reverse())).toEqual(shape(live));
  });

  it("keeps an incomplete pair visible instead of dropping its route", () => {
    expect(dcRouteGroups([{ dc: 1 }, { dc: -2 }])).toEqual([
      { id: 1, main: { dc: 1 } },
      { id: 2, media: { dc: -2 } },
    ]);
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
    expect(dcNodeAriaLabel(dc({ dc: -4 }), ru)).toContain("медиа-маршрут DC 4");
    expect(dcNodeAriaLabel(dc({ dc: -203 }), ru)).toContain("медиа-маршрут DC 203");
    expect(dcNodeAriaLabel(dc({ dc: 203 }), ru)).not.toContain("медиа-маршрут");
    expect(dcNodeAriaLabel(dc({ dc: 4 }), ru)).not.toContain("медиа-маршрут");
  });
});
