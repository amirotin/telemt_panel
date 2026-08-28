import { describe, expect, it } from "vitest";
import { dcPagePayload } from "./dc.helpers";
import type { DcStatus, DcStatusData } from "../../realtime/topics";
import { selectDcContext } from "../details-builder/definitions/dc";

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

describe("selectDcContext", () => {
  it("folds the response metadata into the selected DC", () => {
    const context = selectDcContext(payload([dc({ dc: 2 }), dc({ dc: 4 })]), "dc4");
    expect(context?.dc).toBe(4);
    expect(context?.middle_proxy_enabled).toBe(true);
    expect(context?.generated_at_epoch_secs).toBe(1756000000);
  });

  it("falls back to the first DC for an unknown or missing key", () => {
    const data = payload([dc({ dc: 2 }), dc({ dc: 4 })]);
    expect(selectDcContext(data, undefined)?.dc).toBe(2);
    expect(selectDcContext(data, "dc999")?.dc).toBe(2);
  });

  it("returns null when there is no DC at all", () => {
    expect(selectDcContext(payload([]), undefined)).toBeNull();
  });

  it("merges only the matching DC's network path", () => {
    const data = { ...payload([dc({ dc: 2 }), dc({ dc: 4 })]), network_paths: [{ dc: 2 }] };
    expect(selectDcContext(data, "dc2")?.network_path).toEqual({ dc: 2 });
    expect(selectDcContext(data, "dc4")?.network_path).toBeUndefined();
  });

  it("omits `reason` entirely when the proxy did not send one", () => {
    const context = selectDcContext(payload([dc()]), "dc2");
    // Absent, not null: §13.1 keeps "did not arrive" apart from "arrived
    // empty", and a null here would print the wrong one of the two.
    expect(context !== null && "reason" in context).toBe(false);
  });
});
