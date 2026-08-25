import { describe, expect, it } from "vitest";
import { computeSelftestView, selftestPillState } from "./selftest.helpers";
import type { RuntimeMeSelftest } from "../../realtime/topics";

function selftest(overrides: Partial<RuntimeMeSelftest> = {}): RuntimeMeSelftest {
  return {
    kdf: { state: "ok", ewma_errors_per_min: 0, threshold_errors_per_min: 1, errors_total: 0 },
    timeskew: { state: "ok", max_skew_secs_15m: 2, samples_15m: 10 },
    ip: {},
    pid: { pid: 123, state: "ok" },
    bnd: null,
    ...overrides,
  };
}

describe("computeSelftestView", () => {
  it("reads the sub-state strings and max skew", () => {
    expect(computeSelftestView(selftest())).toEqual({
      kdfState: "ok",
      timeskewState: "ok",
      maxSkewSecs15m: 2,
      pidState: "ok",
    });
  });

  it("passes through a null max skew (no samples yet)", () => {
    const view = computeSelftestView(selftest({ timeskew: { state: "unknown", max_skew_secs_15m: null, samples_15m: 0 } }));
    expect(view.maxSkewSecs15m).toBeNull();
  });
});

describe("selftestPillState", () => {
  it("maps ok/warn/degraded/empty/other", () => {
    expect(selftestPillState("ok")).toBe("ok");
    expect(selftestPillState("warn")).toBe("warn");
    expect(selftestPillState("degraded")).toBe("warn");
    expect(selftestPillState("")).toBe("muted");
    expect(selftestPillState("error")).toBe("error");
    expect(selftestPillState("something_else")).toBe("error");
  });
});
