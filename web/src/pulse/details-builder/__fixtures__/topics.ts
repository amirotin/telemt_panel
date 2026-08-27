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
