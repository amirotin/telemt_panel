// Composed topic snapshots — the payloads a Details page actually receives
// from useSnapshot, assembled exactly the way internal/hub/hub.go composes
// them (statsSnapshot / runtimeSnapshot / upstreamsSnapshot /
// securitySnapshot). Building these from the same per-endpoint fixtures the
// rest of this directory exports is what keeps "what the page renders" and
// "what the wire carries" from drifting apart.
import type {
  SecurityTopic,
  StatsSnapshot,
  RuntimeTopic,
  UpstreamsTopic,
} from "../../../realtime/topics";
import {
  connectionsSummary,
  events,
  gated,
  gates,
  initialization,
  mePoolState,
  meQuality,
  meSelftest,
  natStunLive10,
} from "./runtime";
import { dcs, meWriters, minimalAll, summary, upstreams, upstreamQuality } from "./stats";
import { effectiveLimits, posture, whitelist } from "./security";
import { gatedOff } from "./edges";

export const statsSnapshot: StatsSnapshot = {
  health: { status: "ok", read_only: false },
  summary,
  ready: {
    ready: true,
    status: "ready",
    admission_open: true,
    healthy_upstreams: 1,
    total_upstreams: 1,
  },
  connections_summary: gated(connectionsSummary),
  version: "3.5.2",
  uptime_seconds: 864321,
};

// runtimeSnapshot — the full runtime composite with runtime_edge on, so
// recent_events is present (hub.go omits the key entirely when it is off).
export const runtimeSnapshot: RuntimeTopic = {
  gates,
  initialization,
  me_pool_state: gated(mePoolState),
  me_quality: gated(meQuality),
  nat_stun: gated(natStunLive10),
  me_selftest: gated(meSelftest),
  minimal: gated(minimalAll),
  upstream_quality: upstreamQuality,
  recent_events: gated(events),
};

export const upstreamsSnapshot: UpstreamsTopic = {
  upstreams,
  dcs,
  me_writers: meWriters,
};

// securitySnapshot carries no TLS fingerprints — they left this topic in
// M4 task 1 and arrive through GET /api/telemt/tls-fingerprints instead
// (see the `tlsFingerprints` fixture in ./security).
export const securitySnapshot: SecurityTopic = {
  posture,
  whitelist,
  effective_limits: effectiveLimits,
};

// --- cross-version snapshots (ruling R5) ---------------------------------
//
// Three builds, three different ways the same capability is "not here", and
// the panel must not blur them into one sentence:
//
//   * `oldBuildStatsSnapshot`/`oldBuildRuntimeSnapshot` — Telemt 3.4.x. The
//     runtime-edge routes do not exist, so the panel's capability probe
//     fails, hub.go never fetches them, and `connections_summary`/
//     `recent_events` are simply not on the wire. This is indistinguishable
//     ON THE TOPIC from the same build with the feature switched off, which
//     is why the panel says `disabled` for both: "here is the setting" is
//     the recoverable mistake, "go upgrade your proxy" is not. The REST half
//     of the same story IS distinguishable and stays so — an absent route
//     answers 501 capability_absent, a closed gate 503
//     capability_unavailable (internal/httpapi/telemt_tls_handler.go).
//   * `capabilityAbsentRuntimeSnapshot` — a build that DOES answer and says
//     the feature is absent in the wrapper's own reason token. That one is
//     `unsupported`, and its hint points at an update rather than a switch.
//   * `edgeOffRuntimeSnapshot` — present wrapper, `feature_disabled`: the
//     admin has a switch to flip.

const withoutKeys = <T extends object>(base: T, keys: readonly (keyof T)[]): T => {
  const next = { ...base };
  for (const key of keys) delete next[key];
  return next;
};

/** Telemt 3.4.x: no runtime-edge routes at all, so no `connections_summary`. */
export const oldBuildStatsSnapshot: StatsSnapshot = {
  ...withoutKeys(statsSnapshot, ["connections_summary"]),
  version: "3.4.9",
};

/** The same build's runtime topic: no `recent_events`, minimal group intact. */
export const oldBuildRuntimeSnapshot: RuntimeTopic = withoutKeys(runtimeSnapshot, [
  "recent_events",
]);

/** A build that answers and names the absence itself — R5's `unsupported`. */
export const capabilityAbsentRuntimeSnapshot: RuntimeTopic = {
  ...runtimeSnapshot,
  nat_stun: gatedOff("capability_absent"),
  me_pool_state: gatedOff("capability_absent"),
};

/** runtime_edge switched off on a build that has it — R5's `disabled`. */
export const edgeOffRuntimeSnapshot: RuntimeTopic = {
  ...runtimeSnapshot,
  nat_stun: gatedOff(),
  me_pool_state: gatedOff(),
  recent_events: gatedOff(),
};
