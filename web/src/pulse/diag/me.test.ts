import { describe, expect, it } from "vitest";
import { mePagePayload, meRouteMode } from "./me.helpers";
import {
  gates,
  initialization,
  mePoolState,
  meQuality,
  meRuntime,
  meSelftest,
  meWriters,
} from "../details-builder/__fixtures__";

// mePagePayload is all that is left of the old `meGroups`: it says WHERE the
// ME page's five independently gated halves come from, and nothing about
// what the page shows (definitions/me.ts owns that). These tests pin the one
// property the definition depends on — a half that did not arrive is ABSENT
// from the payload rather than present-and-empty, so §13.1 can tell "the
// gate is off" from "the value is zero".

describe("mePagePayload", () => {
  it("returns null when nothing has arrived yet", () => {
    expect(mePagePayload({})).toBeNull();
    expect(mePagePayload({ meWriters: null, gates: null, initialization: null })).toBeNull();
  });

  it("spreads the me-writers response flat, the way the field catalog keys it", () => {
    const payload = mePagePayload({ meWriters });
    expect(payload).not.toBeNull();
    expect(payload?.summary).toBe(meWriters.summary);
    expect(payload?.writers).toBe(meWriters.writers);
    expect(payload?.middle_proxy_enabled).toBe(true);
    expect(payload?.generated_at_epoch_secs).toBe(meWriters.generated_at_epoch_secs);
    // The healthy fixture carries no reason, and an absent key must stay
    // absent rather than become `undefined` in the payload.
    expect("reason" in (payload ?? {})).toBe(false);
  });

  it("keeps each runtime half optional and independent", () => {
    const onlyGates = mePagePayload({ gates });
    expect(onlyGates?.gates).toBe(gates);
    expect(onlyGates?.pool).toBeUndefined();
    expect(onlyGates?.quality).toBeUndefined();
    expect(onlyGates?.selftest).toBeUndefined();
    expect(onlyGates?.me_runtime).toBeUndefined();

    const gatedOff = mePagePayload({ meWriters, gates, initialization });
    expect(Object.keys(gatedOff ?? {})).not.toContain("pool");
    expect(Object.keys(gatedOff ?? {})).not.toContain("me_runtime");
  });

  it("nests the runtime halves under their own prefixes", () => {
    const payload = mePagePayload({
      meWriters,
      gates,
      initialization,
      pool: mePoolState,
      quality: meQuality,
      selftest: meSelftest,
      meRuntime,
    });
    expect(payload?.pool).toBe(mePoolState);
    expect(payload?.quality).toBe(meQuality);
    expect(payload?.selftest).toBe(meSelftest);
    expect(payload?.me_runtime).toBe(meRuntime);
    // `pool.writers` and the top-level `writers[]` are different things and
    // must never collapse onto one path — that is the whole reason the
    // runtime halves keep their prefixes while me-writers is spread flat.
    expect(payload?.writers).toBe(meWriters.writers);
    expect(payload?.pool?.writers.total).toBe(mePoolState.writers.total);
  });
});

describe("meRouteMode", () => {
  it("distinguishes configured ME, fallback, and direct-only operation", () => {
    expect(
      meRouteMode(
        { ...gates, use_middle_proxy: true, route_mode: "middle", reroute_active: false },
        meWriters,
      ),
    ).toBe("middle");
    expect(
      meRouteMode(
        { ...gates, use_middle_proxy: true, route_mode: "direct", reroute_active: true },
        meWriters,
      ),
    ).toBe("fallback");
    expect(
      meRouteMode(
        { ...gates, use_middle_proxy: false, route_mode: "direct", reroute_active: false },
        { ...meWriters, middle_proxy_enabled: false },
      ),
    ).toBe("direct");
  });
});
