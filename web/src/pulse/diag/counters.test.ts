import { describe, expect, it } from "vitest";
import {
  computeCounterDeltas,
  countersRestarted,
  readCounterValues,
} from "./counters.helpers";
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
    expect(result.sincePrevious["core.a_total"]).toBe(100);
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
    expect(result.sincePrevious).toEqual({});
    expect(result.sinceOpen).toEqual({});
  });

  it("produces no rate when two answers share a timestamp", () => {
    const result = computeCounterDeltas({
      previous: at(5_000, { "core.a_total": 1 }),
      baseline: at(5_000, { "core.a_total": 1 }),
      current: at(5_000, { "core.a_total": 9 }),
    });
    expect(result.perSecond).toEqual({});
    expect(result.sincePrevious).toEqual({});
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
    expect(result.sincePrevious).toEqual({});
    expect(result.sinceOpen).toEqual({});
  });

  it("reports a gauge going down honestly — that is not a reset", () => {
    // `pool_drain_active` and `configured_users` live in the same five
    // groups and legitimately fall. A blanket "negative means restart"
    // would hide exactly the movement a reader opened the page for, so the
    // uptime has to keep rising for the drop to be believed.
    const result = computeCounterDeltas({
      previous: at(0, { "pool.pool_drain_active": 12, "core.uptime_seconds": 900 }),
      baseline: at(0, { "pool.pool_drain_active": 12, "core.uptime_seconds": 900 }),
      current: at(1_000, { "pool.pool_drain_active": 4, "core.uptime_seconds": 901 }),
    });
    expect(result.perSecond["pool.pool_drain_active"]).toBe(-8);
    expect(result.sinceOpen["pool.pool_drain_active"]).toBe(-8);
  });

  it("prints no rate at all across a Telemt restart", () => {
    // The live shape of the bug: a monotonic counter at 1 923 513 answers 0
    // ten seconds later, which as arithmetic is «−192 351,3/с» — a rate no
    // proxy can produce. Uptime fell from 3 600 s to 4 s, so the pair is
    // dropped whole rather than subtracted.
    const result = computeCounterDeltas({
      previous: at(0, { "core.connections_total": 1_923_513, "core.uptime_seconds": 3_600 }),
      baseline: at(0, { "core.connections_total": 1_923_513, "core.uptime_seconds": 3_600 }),
      current: at(10_000, { "core.connections_total": 0, "core.uptime_seconds": 4 }),
    });
    expect(result.perSecond).toEqual({});
    expect(result.sinceOpen).toEqual({});
    expect(countersRestarted(
      { "core.uptime_seconds": 3_600 },
      { "core.uptime_seconds": 4 },
    )).toBe(true);
  });

  it("keeps comparing once the new run is the one being read", () => {
    const result = computeCounterDeltas({
      previous: at(0, { "core.connections_total": 10, "core.uptime_seconds": 4 }),
      baseline: at(0, { "core.connections_total": 10, "core.uptime_seconds": 4 }),
      current: at(10_000, { "core.connections_total": 40, "core.uptime_seconds": 14 }),
    });
    expect(result.perSecond["core.connections_total"]).toBe(3);
    expect(result.sinceOpen["core.connections_total"]).toBe(30);
  });

  it("cannot call a restart on a payload that reports no uptime", () => {
    // A build that stops reporting `core.uptime_seconds` must not silently
    // turn every negative delta into a suppressed one.
    expect(countersRestarted({ "core.a_total": 500 }, { "core.a_total": 0 })).toBe(false);
    expect(countersRestarted(undefined, { "core.uptime_seconds": 4 })).toBe(false);
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
