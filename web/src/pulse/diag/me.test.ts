import { describe, expect, it } from "vitest";
import { meGroups } from "./me.helpers";
import type { RuntimeMePoolState, RuntimeMeSelftest } from "../../realtime/topics";

const pool: RuntimeMePoolState = {
  generations: { active_generation: 1, warm_generation: 1, pending_hardswap_generation: 0, pending_hardswap_age_secs: null, draining_generations: [] },
  hardswap: { enabled: true, pending: false },
  writers: { total: 5, alive_non_draining: 5, draining: 0, degraded: 0, contour: { warm: 0, active: 5, draining: 0 }, health: { healthy: 5, degraded: 0, draining: 0 } },
  refill: { inflight_endpoints_total: 0, inflight_dc_total: 0, by_dc: [] },
};

const selftest: RuntimeMeSelftest = {
  kdf: { state: "ok", ewma_errors_per_min: 0, threshold_errors_per_min: 1, errors_total: 0 },
  timeskew: { state: "ok", max_skew_secs_15m: 0, samples_15m: 5 },
  ip: {},
  pid: { pid: 1, state: "ok" },
  bnd: null,
};

describe("meGroups", () => {
  it("returns no groups when every input is absent", () => {
    expect(meGroups({})).toEqual([]);
  });

  it("includes the four pool sub-groups when pool is present", () => {
    const groups = meGroups({ pool });
    expect(groups.map((g) => g.title)).toEqual(["Поколения", "Hardswap", "Писатели", "Довыгрузка (refill)"]);
  });

  it("omits bnd/selftestUpstreams groups when those fields are null/absent", () => {
    const groups = meGroups({ selftest });
    expect(groups.map((g) => g.title)).toEqual(["KDF", "Расхождение времени", "Определённый IP", "ME-процесс"]);
  });

  it("includes bnd when present", () => {
    const groups = meGroups({ selftest: { ...selftest, bnd: { addr_state: "ok", port_state: "ok" } } });
    expect(groups.map((g) => g.title)).toContain("Bind-адрес");
  });

  it("combines pool, selftest, gates and initialization independently", () => {
    const groups = meGroups({
      pool,
      selftest,
      gates: {
        accepting_new_connections: true,
        conditional_cast_enabled: false,
        me_runtime_ready: true,
        me2dc_fallback_enabled: false,
        me2dc_fast_enabled: false,
        use_middle_proxy: true,
        route_mode: "me",
        reroute_active: false,
        startup_status: "ready",
        startup_stage: "done",
        startup_progress_pct: 100,
      },
    });
    expect(groups.map((g) => g.title)).toEqual([
      "Поколения",
      "Hardswap",
      "Писатели",
      "Довыгрузка (refill)",
      "KDF",
      "Расхождение времени",
      "Определённый IP",
      "ME-процесс",
      "Гейты",
    ]);
  });
});
