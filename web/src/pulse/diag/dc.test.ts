import { describe, expect, it } from "vitest";
import { dcEntityKey, dcPagePayload } from "./dc.helpers";
import type { DcStatus, DcStatusData } from "../../realtime/topics";

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

function payload(dcs: DcStatus[]): DcStatusData {
  return { middle_proxy_enabled: true, generated_at_epoch_secs: 1756000000, dcs };
}

describe("dcPagePayload", () => {
  it("returns null when the topic has no DC payload yet", () => {
    expect(dcPagePayload(null)).toBeNull();
    expect(dcPagePayload(undefined)).toBeNull();
  });

  it("passes the snapshot through untouched when no network paths are gated in", () => {
    const data = payload([dc()]);
    // Identity, not just equality: the gated-off case must not allocate a
    // new object on every realtime frame (§19.1's "не пересоздавать строки
    // только из-за нового object reference").
    expect(dcPagePayload(data)).toBe(data);
    expect(dcPagePayload(data, [])).toBe(data);
  });

  it("attaches the network paths without touching the DC list", () => {
    const data = payload([dc({ dc: 2 })]);
    const merged = dcPagePayload(data, [{ dc: 2, ip_preference: "prefer_v4" }]);
    expect(merged?.network_paths).toEqual([{ dc: 2, ip_preference: "prefer_v4" }]);
    expect(merged?.dcs).toBe(data.dcs);
  });
});

describe("dcEntityKey", () => {
  it("preserves positive and media DC identities", () => {
    expect(dcEntityKey({ dc: 4 })).toBe("dc4");
    expect(dcEntityKey({ dc: -203 })).toBe("dc-203");
  });
});
