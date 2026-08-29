// Production-size fixtures for the "runtime" family: gates, initialization,
// ME pool/quality/self-test, NAT-STUN, connections summary and recent
// events. Shapes and cardinalities from TELEMT_LIVE_API_DATA.md §13–18.
import type {
  Gated,
  RuntimeEdgeConnectionsSummary,
  RuntimeEdgeEventRecord,
  RuntimeEdgeEvents,
  RuntimeGates,
  RuntimeInitialization,
  RuntimeInitializationComponent,
  RuntimeMePoolState,
  RuntimeMeQuality,
  RuntimeMeQualityDcRtt,
  RuntimeMeSelftest,
  RuntimeNatStun,
} from "../../../realtime/topics";
import { dcIds } from "./stats";
import { rng, spread, times } from "./seed";

// gated wraps a payload the way Telemt's Gated[T] arrives when the source
// is on (07-telemt-sdk.md); the edges module carries the off variants.
export function gated<T>(data: T, generatedAt = 1756000000): Gated<T> {
  return { enabled: true, generated_at_epoch_secs: generatedAt, data };
}

export const gates: RuntimeGates = {
  accepting_new_connections: true,
  conditional_cast_enabled: false,
  me_runtime_ready: true,
  me2dc_fallback_enabled: true,
  me2dc_fast_enabled: false,
  use_middle_proxy: true,
  route_mode: "middle_proxy",
  reroute_active: false,
  startup_status: "ready",
  startup_stage: "serving",
  startup_progress_pct: 100,
};

// initializationComponentCount: 16 components on every VPS (§13), of which
// 14 were `ready` and 2 `skipped` — a stepper, not 141 independent rows.
export const initializationComponentCount = 16;
export const initializationSkippedCount = 2;

const componentIds = [
  "config_load", "listeners_bind", "quota_state_restore", "stats_init", "runtime_events",
  "dc_directory", "me_pool_bootstrap", "me_writers_warmup", "me_generation_activate",
  "upstream_probe", "nat_probe", "tls_fingerprint_store", "api_server", "web_status",
  "conditional_cast", "admission_open",
] as const;

// Durations walked across the observed 0–9838 ms so both ends are present.
const componentDurations = spread(initializationComponentCount, 0, 9838);

export const initialization: RuntimeInitialization = (() => {
  const startedAt = 1755999400;
  let cursorMs = startedAt * 1000;
  const components: RuntimeInitializationComponent[] = times(initializationComponentCount, (i) => {
    // The last two are the `skipped` pair — a skipped step still carries
    // its own timestamps, which is what makes the timeline renderer's
    // "duration but no work" case real.
    const skipped = i >= initializationComponentCount - initializationSkippedCount;
    const duration = skipped ? 0 : componentDurations[i];
    const startedAtMs = cursorMs;
    cursorMs += duration;
    return {
      id: componentIds[i],
      title: componentIds[i].replace(/_/g, " "),
      status: skipped ? "skipped" : "ready",
      started_at_epoch_ms: startedAtMs,
      finished_at_epoch_ms: startedAtMs + duration,
      duration_ms: duration,
      // attempts was 1 for every component in the snapshot.
      attempts: 1,
      details: skipped ? "disabled by configuration" : undefined,
    };
  });
  return {
    status: "ready",
    degraded: false,
    current_stage: "serving",
    progress_pct: 100,
    started_at_epoch_secs: startedAt,
    ready_at_epoch_secs: startedAt + 41,
    total_elapsed_ms: componentDurations.reduce((a, b) => a + b, 0),
    transport_mode: "middle_proxy",
    me: {
      status: "ready",
      current_stage: "serving",
      progress_pct: 100,
      init_attempt: 1,
      retry_limit: "unlimited",
    },
    components,
  };
})();

// mePoolState — 20 leaves (§14). Both nested arrays were empty on every
// VPS, which is the "empty is not absent" case the renderers must honour.
export const mePoolState: RuntimeMePoolState = {
  generations: {
    active_generation: 7,
    warm_generation: 8,
    pending_hardswap_generation: 0,
    pending_hardswap_age_secs: null,
    draining_generations: [],
  },
  hardswap: { enabled: true, pending: false },
  writers: {
    total: 46,
    alive_non_draining: 46,
    draining: 0,
    degraded: 3,
    contour: { warm: 4, active: 42, draining: 0 },
    health: { healthy: 43, degraded: 3, draining: 0 },
  },
  refill: { inflight_endpoints_total: 0, inflight_dc_total: 0, by_dc: [] },
};

// meQualityDcRtt — 12 per-DC rows (§14), coverage 100%, RTT 4–342 ms.
const dcRttValues = spread(dcIds.length, 4, 342);
export const meQualityDcRtt: RuntimeMeQualityDcRtt[] = dcIds.map((dc, i) => ({
  dc,
  rtt_ema_ms: dcRttValues[i],
  alive_writers: 3 + (i % 9),
  required_writers: 3 + (i % 9),
  coverage_pct: 100,
}));

// meQuality — two family states, both healthy, as on all three VPS (§14).
export const meQuality: RuntimeMeQuality = {
  counters: {
    idle_close_by_peer_total: 1204,
    reader_eof_total: 87,
    kdf_drift_total: 0,
    kdf_port_only_drift_total: 0,
    reconnect_attempt_total: 331,
    reconnect_success_total: 329,
  },
  route_drops: {
    no_conn_total: 4,
    channel_closed_total: 1,
    queue_full_total: 0,
    queue_full_base_total: 0,
    queue_full_high_total: 0,
  },
  family_states: [
    { family: "v4", state: "healthy", state_since_epoch_secs: 1755999441, fail_streak: 0, recover_success_streak: 12 },
    { family: "v6", state: "healthy", state_since_epoch_secs: 1755999443, fail_streak: 0, recover_success_streak: 9 },
  ],
  drain_gate: {
    route_quorum_ok: true,
    redundancy_ok: true,
    block_reason: "",
    updated_at_epoch_secs: 1756000000,
  },
  dc_rtt: meQualityDcRtt,
};

// meSelftest — the nullable-branch fixture (§16): `ip.v6` and the SDK's
// `upstreams[]` are absent here exactly as they were in the live snapshot,
// which is why schema equality across the three VPS was false. The edges
// module carries the other combinations.
export const meSelftest: RuntimeMeSelftest = {
  kdf: { state: "ok", ewma_errors_per_min: 0, threshold_errors_per_min: 5, errors_total: 0 },
  timeskew: {
    state: "ok",
    max_skew_secs_15m: 1,
    samples_15m: 90,
    last_skew_secs: 0,
    last_source: "me",
    last_seen_age_secs: 12,
  },
  ip: { v4: { addr: "198.51.100.7", state: "stable" } },
  pid: { pid: 4711, state: "ok" },
  bnd: { addr_state: "stable", port_state: "stable", last_addr: "198.51.100.7", last_seen_age_secs: 12 },
};

// natStunConfiguredCount: 13 configured servers on every VPS (§15) while
// the live count differed sharply — 10 / 7 / 0. That divergence is a real
// production state, not a mock edge case, hence three named fixtures.
export const natStunConfiguredCount = 13;

const stunServers = times(natStunConfiguredCount, (i) => `stun${i + 1}.example.net:3478`);

function makeNatStun(liveCount: number): RuntimeNatStun {
  return {
    flags: { nat_probe_enabled: true, nat_probe_disabled_runtime: false, nat_probe_attempts: 3 },
    servers: { configured: stunServers, live: stunServers.slice(0, liveCount), live_total: liveCount },
    reflection:
      liveCount === 0
        ? {}
        : { v4: { addr: "198.51.100.7", age_secs: 41 }, v6: { addr: "2001:db8::7", age_secs: 44 } },
    stun_backoff_remaining_ms: liveCount === 0 ? 12000 : undefined,
  };
}

/** node-a: 13 configured, 10 live. */
export const natStunLive10 = makeNatStun(10);
/** node-b: 13 configured, 7 live. */
export const natStunLive7 = makeNatStun(7);
/** node-c: 13 configured, none live — reflection has neither v4 nor v6. */
export const natStunLive0 = makeNatStun(0);

// connectionsSummary — two top-10 rankings over the same users (§17):
// connections 1–25, octets ~5.6–47.2 billion.
export const connectionsTopLimit = 10;

export const connectionsSummary: RuntimeEdgeConnectionsSummary = (() => {
  const r = rng(0xc0e5);
  const usernames = times(14, (i) => `user_${String(i + 1).padStart(2, "0")}`);
  const byConnections = times(connectionsTopLimit, (i) => ({
    username: usernames[i],
    current_connections: 25 - i * 2,
    total_octets: r.int(5_600_000_000, 47_200_000_000),
  })).sort((a, b) => b.current_connections - a.current_connections);
  // Same population, different ranking criterion — deliberately overlapping
  // but not identical, which is what §23.5's two RankingSections render.
  const byThroughput = times(connectionsTopLimit, (i) => ({
    username: usernames[(i + 3) % usernames.length],
    current_connections: r.int(1, 25),
    total_octets: 47_200_000_000 - i * 4_100_000_000,
  }));
  return {
    cache: { ttl_ms: 1000, served_from_cache: true, stale_cache_used: false },
    totals: {
      current_connections: 214,
      current_connections_me: 198,
      current_connections_direct: 16,
      active_users: 14,
    },
    top: { limit: connectionsTopLimit, by_connections: byConnections, by_throughput: byThroughput },
    telemetry: { user_enabled: true, throughput_is_cumulative: true },
  };
})();

// eventCount: exactly 50 on every VPS at ?limit=50 (§18), overwhelmingly
// admission.state with a config reload and a single user mutation mixed in.
export const eventCount = 50;
export const admissionEventCount = 48;

export const events: RuntimeEdgeEvents = (() => {
  const records: RuntimeEdgeEventRecord[] = times(eventCount, (i) => {
    const seq = 90000 + i;
    const ts = 1755996000 + i * 60;
    if (i === eventCount - 2) {
      return { seq, ts_epoch_secs: ts, event_type: "config.reload.applied", context: "generation 8 activated" };
    }
    if (i === eventCount - 1) {
      return { seq, ts_epoch_secs: ts, event_type: "api.user.create.ok", context: "username=user_15" };
    }
    return {
      seq,
      ts_epoch_secs: ts,
      event_type: "admission.state",
      context: i % 2 === 0 ? "open (healthy_upstreams=1)" : "open (me_runtime_ready=true)",
    };
  });
  return { capacity: 200, dropped_total: 0, events: records };
})();
