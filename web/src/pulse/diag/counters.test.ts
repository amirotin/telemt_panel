import { describe, expect, it } from "vitest";
import { computeCounterDeltas, readCounterValues } from "./counters.helpers";
import { zeroAll } from "../details-builder/__fixtures__";
import type { ZeroAllData } from "../../lib/api/generated/types.gen";

// counters.helpers.ts is what is left of `countersGroups`: the page's
// composition moved to definitions/counters.ts, and this module now only
// answers ruling R4's arithmetic — what changed between two answers, and by
// how much since the reader opened the page.

describe("readCounterValues", () => {
  it("reads the numeric leaves of all five zero/all groups", () => {
    const values = readCounterValues(zeroAll);
    expect(values["core.core_0_total"]).toBe(zeroAll.core["core_0_total"]);
    expect(values["upstream.upstream_0_total"]).toBe(zeroAll.upstream["upstream_0_total"]);
    expect(values["middle_proxy.me_0_total"]).toBe(zeroAll.middle_proxy["me_0_total"]);
    expect(values["pool.pool_0_total"]).toBe(zeroAll.pool["pool_0_total"]);
    expect(values["desync.desync_0_total"]).toBe(zeroAll.desync["desync_0_total"]);
  });

  it("skips the nested breakdown arrays — they are not counters", () => {
    const values = readCounterValues(zeroAll);
    expect(Object.keys(values).some((k) => k.includes("by_class"))).toBe(false);
    expect(Object.keys(values).some((k) => k.includes("handshake_error_codes"))).toBe(false);
  });

  it("skips non-numeric leaves, so a policy flag never gets a rate", () => {
    const withFlags = {
      ...zeroAll,
      core: { ...zeroAll.core, telemetry_core_enabled: true, telemetry_me_level: "normal" },
    } as unknown as ZeroAllData;
    const values = readCounterValues(withFlags);
    expect(values["core.telemetry_core_enabled"]).toBeUndefined();
    expect(values["core.telemetry_me_level"]).toBeUndefined();
  });

  it("is empty for a payload that never arrived", () => {
    expect(readCounterValues(undefined)).toEqual({});
  });
});

describe("computeCounterDeltas (ruling R4)", () => {
  const at = (ms: number, values: Record<string, number>) => ({ values, atMs: ms });

  it("divides the difference by the elapsed time", () => {
    const result = computeCounterDeltas({
      previous: at(1_000, { "core.a_total": 100 }),
      baseline: at(1_000, { "core.a_total": 100 }),
      current: at(11_000, { "core.a_total": 200 }),
    });
    expect(result.perSecond["core.a_total"]).toBe(10);
    expect(result.sinceOpen["core.a_total"]).toBe(100);
  });

  it("gives a counter that only just appeared no delta at all", () => {
    const result = computeCounterDeltas({
      previous: at(1_000, {}),
      baseline: at(1_000, {}),
      current: at(2_000, { "core.new_total": 5 }),
    });
    // A new key is not a jump from zero — inventing one would report a rate
    // for a counter Telemt only just started sending.
    expect(result.perSecond).toEqual({});
    expect(result.sinceOpen).toEqual({});
  });

  it("produces no rate when two answers share a timestamp", () => {
    const result = computeCounterDeltas({
      previous: at(5_000, { "core.a_total": 1 }),
      baseline: at(5_000, { "core.a_total": 1 }),
      current: at(5_000, { "core.a_total": 9 }),
    });
    expect(result.perSecond).toEqual({});
    // The since-open column still works: it is a difference, not a rate.
    expect(result.sinceOpen["core.a_total"]).toBe(8);
  });

  it("has neither column before a second answer arrives", () => {
    const result = computeCounterDeltas({
      previous: null,
      baseline: null,
      current: at(1_000, { "core.a_total": 3 }),
    });
    expect(result.perSecond).toEqual({});
    expect(result.sinceOpen).toEqual({});
  });

  it("reports a decrease honestly, the way a restarted proxy produces one", () => {
    const result = computeCounterDeltas({
      previous: at(0, { "core.a_total": 500 }),
      baseline: at(0, { "core.a_total": 500 }),
      current: at(1_000, { "core.a_total": 0 }),
    });
    expect(result.perSecond["core.a_total"]).toBe(-500);
    expect(result.sinceOpen["core.a_total"]).toBe(-500);
  });

  it("rounds a rate to two decimals rather than printing a float tail", () => {
    const result = computeCounterDeltas({
      previous: at(0, { "core.a_total": 0 }),
      baseline: at(0, { "core.a_total": 0 }),
      current: at(3_000, { "core.a_total": 1 }),
    });
    expect(result.perSecond["core.a_total"]).toBe(0.33);
  });
});
