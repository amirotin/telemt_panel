import { describe, expect, it } from "vitest";
import { en, ru, type Dict } from "../i18n";
import {
  gateHint,
  resolveGateHint,
  ME_POOL_RUNTIME_HINTS,
  MINIMAL_STATS_HINTS,
  RUNTIME_EDGE_HINTS,
  UPSTREAM_QUALITY_HINTS,
  UPSTREAM_STATS_HINTS,
  type GateHintByReason,
  WEB_RUNTIME_HINTS,
  type GateHintKey,
} from "./gateHints";

// The (endpoint, reason) table, transcribed from Telemt 3.5.5's own source
// and not from the panel's prior belief:
//
//   runtime_edge.rs   — connections/events/tls close `feature_disabled` on
//                       `runtime_edge_enabled = false`, `source_unavailable`
//                       when the payload cache refill loses its race.
//   runtime_stats.rs  — /v1/stats/{minimal/all,me-writers,dcs,upstreams}
//                       close `feature_disabled` on
//                       `minimal_runtime_enabled = false`; their
//                       `source_unavailable` is the ME pool being None
//                       (the minimal payload) or a lost `try_read` on the
//                       upstream manager (upstreams).
//   runtime_min.rs    — nat-stun / me-pool-state / me-quality and
//                       upstream-quality take NO ApiConfig at all: they are
//                       registered unconditionally and can only ever answer
//                       `source_unavailable`.
const TABLE: readonly {
  endpoint: string;
  spec: GateHintByReason;
  feature_disabled: GateHintKey;
  source_unavailable: GateHintKey;
  /** No reason on the wire — the field arrived omitted, not as a wrapper. */
  omitted: GateHintKey;
}[] = [
  {
    endpoint: "/v1/runtime/connections/summary",
    spec: RUNTIME_EDGE_HINTS,
    feature_disabled: "runtime_edge",
    source_unavailable: "source_temporarily_unavailable",
    omitted: "runtime_edge",
  },
  {
    endpoint: "/v1/stats/dcs",
    spec: MINIMAL_STATS_HINTS,
    feature_disabled: "minimal_runtime_enabled",
    source_unavailable: "me_pool_unavailable",
    omitted: "minimal_runtime_enabled",
  },
  {
    endpoint: "/v1/stats/upstreams",
    spec: UPSTREAM_STATS_HINTS,
    feature_disabled: "minimal_runtime_enabled",
    source_unavailable: "source_temporarily_unavailable",
    omitted: "minimal_runtime_enabled",
  },
  {
    endpoint: "/v1/runtime/nat-stun",
    spec: ME_POOL_RUNTIME_HINTS,
    // No flag gates the route: even if a build ever answered
    // `feature_disabled` here, the panel must not invent a switch.
    feature_disabled: "me_pool_unavailable",
    source_unavailable: "me_pool_unavailable",
    omitted: "me_pool_unavailable",
  },
  {
    endpoint: "/v1/runtime/upstream-quality",
    spec: UPSTREAM_QUALITY_HINTS,
    feature_disabled: "source_temporarily_unavailable",
    source_unavailable: "source_temporarily_unavailable",
    omitted: "source_temporarily_unavailable",
  },
];

// Which config flag each hint is allowed to name. A hint for a route no flag
// gates must name none of them — that is exactly the defect this file pins.
const FLAG_OF: Partial<Record<GateHintKey, string>> = {
  runtime_edge: "runtime_edge_enabled",
  minimal_runtime_enabled: "minimal_runtime_enabled",
  me_pool_unavailable: "use_middle_proxy",
};
const ALL_FLAGS = ["runtime_edge_enabled", "minimal_runtime_enabled", "use_middle_proxy"];

const LOCALES: readonly [string, Dict][] = [
  ["ru", ru],
  ["en", en],
];

describe("gate hints resolve per (endpoint, reason)", () => {
  for (const row of TABLE) {
    it(`${row.endpoint} picks the hint its reason earns`, () => {
      expect(resolveGateHint(row.spec, "feature_disabled")).toBe(row.feature_disabled);
      expect(resolveGateHint(row.spec, "source_unavailable")).toBe(row.source_unavailable);
      expect(resolveGateHint(row.spec, undefined)).toBe(row.omitted);
      // An unknown token is not a licence to say nothing: the route's most
      // likely cause is still better than a blank follow-up.
      expect(resolveGateHint(row.spec, "some_future_token")).toBe(row.omitted);
    });
  }

  it("passes a plain key through unchanged and undefined through as undefined", () => {
    expect(resolveGateHint("telemt_outdated", "feature_disabled")).toBe("telemt_outdated");
    expect(resolveGateHint(undefined, "feature_disabled")).toBeUndefined();
  });
});

describe.each(LOCALES)("gate hint text (%s)", (locale, dict) => {
  for (const row of TABLE) {
    for (const reason of ["feature_disabled", "source_unavailable", undefined] as const) {
      it(`${row.endpoint} + ${reason ?? "no reason"} names only a real cause`, () => {
        const key = resolveGateHint(row.spec, reason)!;
        const text = gateHint(dict, key);
        expect(text.length, `${locale} ${key}`).toBeGreaterThan(0);

        const allowed = FLAG_OF[key];
        for (const flag of ALL_FLAGS) {
          if (flag === allowed) {
            expect(text, `${locale} ${key} must name ${flag}`).toContain(flag);
          } else {
            expect(text, `${locale} ${key} must not name ${flag}`).not.toContain(flag);
          }
        }
      });
    }
  }

  it("never sends a NAT/STUN operator to a config flag", () => {
    for (const reason of ["feature_disabled", "source_unavailable", undefined] as const) {
      const text = gateHint(dict, resolveGateHint(ME_POOL_RUNTIME_HINTS, reason)!);
      expect(text, locale).not.toContain("minimal_runtime_enabled");
      expect(text, locale).not.toContain("runtime_edge_enabled");
    }
  });

  it("gives every hint key distinct text", () => {
    const keys = [
      ...new Set(TABLE.flatMap((r) => [r.feature_disabled, r.source_unavailable, r.omitted])),
    ];
    const texts = keys.map((k) => gateHint(dict, k));
    expect(new Set(texts).size, locale).toBe(keys.length);
  });
});

// The WEB group's reasons are lifecycle-derived, not the
// feature_disabled/source_unavailable pair, and they do NOT all mean the
// same thing: `starting` and `runtime_released` describe a runtime that IS
// enabled and is moving, where "set [web] enabled = true and restart the
// proxy" is wrong advice and, mid-drain, destructive.
describe("the WEB runtime's reason split", () => {
  const WAIT = ["starting", "runtime_released"] as const;
  const SWITCH_ON = ["no_web_listener", "drained", "deadline_exceeded", undefined] as const;

  it("sends a transitional runtime to the wait hint", () => {
    for (const reason of WAIT) {
      expect(resolveGateHint(WEB_RUNTIME_HINTS, reason), reason).toBe("web_runtime_transitional");
    }
  });

  it("keeps the switch-it-on hint for a runtime that really is off", () => {
    for (const reason of SWITCH_ON) {
      expect(resolveGateHint(WEB_RUNTIME_HINTS, reason), String(reason)).toBe("web_enabled");
    }
    // A token this build has not heard of falls back the same way.
    expect(resolveGateHint(WEB_RUNTIME_HINTS, "some_future_token")).toBe("web_enabled");
  });

  it.each(LOCALES)("%s never tells a moving runtime to restart the proxy", (locale, dict) => {
    const wait = gateHint(dict, "web_runtime_transitional");
    expect(wait.length, locale).toBeGreaterThan(0);
    expect(wait, locale).not.toContain("enabled = true");
    // …and the two WEB hints are genuinely different sentences.
    expect(wait, locale).not.toBe(gateHint(dict, "web_enabled"));
  });
});
