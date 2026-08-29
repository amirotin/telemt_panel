import type { Dict } from "../i18n";

// GateHintKey enumerates the panel's static "как включить" hints for a
// disabled capability/gate — Telemt's own Gated[T] wrapper (07-telemt-sdk.md)
// already carries a dynamic `reason` string for its own sub-gates (e.g.
// "minimal runtime gate disabled"), shown as-is by <Gated>; the entries here
// are the panel-authored follow-up text for the capability flags exposed by
// GET /api/telemt/info (07-telemt-sdk.md §SDK-3) and the runtime_edge gate
// that unlocks several of the payloads underneath it. The text itself lives
// in the dictionaries (gated.hints) — this module only owns the key
// enumeration and the typed lookup.
export type GateHintKey =
  | "runtime_edge"
  // telemt_outdated is the one key that is not a capability name: it is the
  // follow-up for `unsupported` (the route is absent from this build, 501
  // capability_absent) as opposed to `disabled` (the feature exists and is
  // switched off) — ruling R5.
  | "telemt_outdated"
  | "quota"
  | "config_api"
  | "reload_api"
  | "user_enable_disable"
  | "rotate_secret"
  | "log_stream"
  | "minimal_runtime_enabled"
  // me_pool_unavailable is not a config flag on the API side at all: the
  // ME-pool-backed payloads close when `shared.me_pool` is None, i.e. the
  // middle proxy is off or the pool has not finished initializing.
  | "me_pool_unavailable"
  // source_temporarily_unavailable is the honest answer to a gate that closed
  // on a momentary snapshot/cache miss (an upstream `try_read` that lost the
  // race, a runtime-edge cache refill in flight): nothing to switch on, the
  // next poll answers.
  | "source_temporarily_unavailable"
  // web_enabled is the WEB group's own switch: `[web] enabled = true` plus a
  // `transport = "web"` listener. Not a runtime_edge/minimal_runtime flag —
  // /v1/runtime/web/* is registered unconditionally and closes only because
  // the runtime itself is not running (Telemt 3.5.5 src/api/web_runtime.rs).
  | "web_enabled";

export function gateHint(s: Dict, key: GateHintKey): string {
  return s.gated.hints[key];
}

// --- reason-aware hints --------------------------------------------------

// GateHintByReason maps Telemt's own gate `reason` token to the follow-up the
// panel prints. One hint per endpoint is not enough: the SAME token means
// different things on different routes, and the same route closes for
// different causes. `/v1/stats/dcs` answers `feature_disabled` when
// `minimal_runtime_enabled = false` and `source_unavailable` when the ME pool
// is down; `/v1/runtime/nat-stun` is registered unconditionally and can ONLY
// answer `source_unavailable` (runtime_min.rs::build_runtime_nat_stun_data
// takes no ApiConfig). Telling a NAT/STUN operator to flip
// `minimal_runtime_enabled` sends them to a setting with no effect on that
// payload — hence the (endpoint, reason) pair, not the endpoint alone.
export interface GateHintByReason {
  /** Telemt's `feature_disabled` — a config flag really gates this route. */
  readonly feature_disabled?: GateHintKey;
  /** Telemt's `source_unavailable` — the data source, not a flag, is closed. */
  readonly source_unavailable?: GateHintKey;
  /** No reason on the wire (the field was omitted entirely) — the route's most likely cause. */
  readonly fallback: GateHintKey;
}

/** A page/card either names one hint outright or resolves it from the reason. */
export type GateHintSpec = GateHintKey | GateHintByReason;

// resolveGateHint picks the hint for one (endpoint, reason) pair. The spec is
// the endpoint half; `reason` is Telemt's own token, absent when the payload
// arrived as an omitted key rather than an explicit {enabled:false} wrapper.
export function resolveGateHint(
  spec: GateHintSpec | undefined,
  reason: string | undefined,
): GateHintKey | undefined {
  if (spec === undefined || typeof spec === "string") return spec;
  if (reason === "feature_disabled") return spec.feature_disabled ?? spec.fallback;
  if (reason === "source_unavailable") return spec.source_unavailable ?? spec.fallback;
  return spec.fallback;
}

// --- the endpoint table --------------------------------------------------
//
// Verified against Telemt 3.5.5 (`src/api/`), not inferred:
//
// | endpoint group                              | feature_disabled      | source_unavailable |
// |---------------------------------------------|-----------------------|--------------------|
// | /v1/runtime/{connections,events,tls} (edge) | runtime_edge_enabled  | cache refill lost  |
// | /v1/stats/{minimal/all,me-writers,dcs}      | minimal_runtime_...   | ME pool is None    |
// | /v1/stats/upstreams                         | minimal_runtime_...   | upstream try_read  |
// | /v1/runtime/{nat-stun,me-pool-*,me-selftest}| (never gated)         | ME pool is None    |
// | /v1/runtime/upstream-quality                | (never gated)         | upstream try_read  |
// | /v1/runtime/web/*                           | (never gated)         | WEB runtime is off |

/** `/v1/runtime/connections/*`, `/events/recent`, `/tls/fingerprints` — runtime_edge.rs. */
export const RUNTIME_EDGE_HINTS: GateHintByReason = {
  feature_disabled: "runtime_edge",
  source_unavailable: "source_temporarily_unavailable",
  fallback: "runtime_edge",
};

/** `/v1/stats/minimal/all`, `/v1/stats/me-writers`, `/v1/stats/dcs` — runtime_stats.rs. */
export const MINIMAL_STATS_HINTS: GateHintByReason = {
  feature_disabled: "minimal_runtime_enabled",
  source_unavailable: "me_pool_unavailable",
  fallback: "minimal_runtime_enabled",
};

/** `/v1/stats/upstreams` — the same flag, but its source is the upstream manager. */
export const UPSTREAM_STATS_HINTS: GateHintByReason = {
  feature_disabled: "minimal_runtime_enabled",
  source_unavailable: "source_temporarily_unavailable",
  fallback: "minimal_runtime_enabled",
};

/** `/v1/runtime/nat-stun`, `/me-pool-state`, `/me-quality`, `/me-selftest` — always registered. */
export const ME_POOL_RUNTIME_HINTS: GateHintByReason = {
  source_unavailable: "me_pool_unavailable",
  fallback: "me_pool_unavailable",
};

/**
 * `/v1/runtime/web/*` — registered unconditionally on Telemt >= 3.5.3. No
 * config FLAG gates the routes; they close because the WEB runtime is not
 * running, which Telemt reports through the status payload's own lifecycle
 * token (`no_web_listener`, `starting`, `drained`, `deadline_exceeded`,
 * `runtime_released`) rather than through the `feature_disabled` /
 * `source_unavailable` pair the other groups use. Every one of those tokens
 * points an operator at the same place — the `[web]` section and its
 * listener — so the fallback answers them all.
 */
export const WEB_RUNTIME_HINTS: GateHintByReason = {
  fallback: "web_enabled",
};

/** `/v1/runtime/upstream-quality` — always registered, closes only on a lost `try_read`. */
export const UPSTREAM_QUALITY_HINTS: GateHintByReason = {
  source_unavailable: "source_temporarily_unavailable",
  fallback: "source_temporarily_unavailable",
};
