// Production-size fixtures for the "stats"/"upstreams" families: summary,
// DCs, ME writers, upstreams, the zero/all counter dump and minimal/all.
// Cardinalities and value ranges come from TELEMT_LIVE_API_DATA.md §4, §6–11
// — three live VPS, not invented numbers. Identifiers are sanitized
// (RFC 5737/3849 documentation addresses, generic usernames); nothing here
// carries a real endpoint, IP or secret.
import type {
  ClassCount,
  DcStatus,
  DcStatusData,
  MeWriterStatus,
  MeWritersData,
  RuntimeMinimalAll,
  RuntimeMinimalDcPath,
  RuntimeMinimalMeRuntime,
  RuntimeUpstreamQualityData,
  StatsSummary,
  UpstreamsData,
} from "../../../realtime/topics";
import { rng, spread, times } from "./seed";

// dcIds: the exact set the live snapshot showed — positive DCs, the 203
// group, and their negative mirrors. IDs must never be treated as positive
// (TELEMT_LIVE_API_DATA.md §9), which is precisely what the negatives here
// are for.
export const dcIds = [1, 2, 3, 4, 5, 203, -1, -2, -3, -4, -5, -203] as const;

// endpointsPerDc walks 1..10 across the 12 DCs so both documented extremes
// (a single-endpoint DC and a ten-endpoint one) are always present.
const endpointsPerDc = spread(dcIds.length, 1, 10);

function endpointAddr(dcIndex: number, endpointIndex: number): string {
  // RFC 5737 TEST-NET-2 with a Telegram-ish port — sanitized, but the same
  // shape and length as a real DC endpoint so layout tests see real widths.
  return `198.51.100.${10 + dcIndex}:${8443 + endpointIndex}`;
}

function makeDc(id: number, index: number, r: ReturnType<typeof rng>): DcStatus {
  const endpointCount = endpointsPerDc[index];
  const required = r.int(3, 11);
  const alive = required;
  return {
    dc: id,
    endpoints: times(endpointCount, (e) => endpointAddr(index, e)),
    // 24 endpoint_writers rows across the 12 DCs (§9) — two per DC.
    endpoint_writers: times(2, (e) => ({
      endpoint: endpointAddr(index, e % endpointCount),
      active_writers: r.int(1, 6),
    })),
    available_endpoints: endpointCount,
    available_pct: 100,
    required_writers: required,
    floor_min: 2,
    floor_target: required,
    floor_max: required + 4,
    floor_capped: false,
    alive_writers: alive,
    // Coverage was 100% on every DC of every VPS during the snapshot.
    coverage_pct: 100,
    fresh_alive_writers: alive,
    fresh_coverage_pct: 100,
    rtt_ms: r.float(4, 342),
    load: r.float(0, 1, 3),
  };
}

// dcs — 12 DC entities, the §23.1 DC Details page's whole data source.
export const dcs: DcStatusData = (() => {
  const r = rng(0xdc12);
  return {
    middle_proxy_enabled: true,
    generated_at_epoch_secs: 1756000000,
    dcs: dcIds.map((id, i) => makeDc(id, i, r)),
  };
})();

// writerCount: 46, mid-range of the observed 44–47 (§8). The count changes
// in live runtime, so nothing may depend on it being constant — the
// inventory test pins this fixture's value, not a protocol rule.
export const writerCount = 46;

// degradedWriterCount: 3, mid-range of the observed 2–4 (§8/§21).
export const degradedWriterCount = 3;

function makeWriter(index: number, r: ReturnType<typeof rng>, rtt: number): MeWriterStatus {
  const dcIndex = index % dcIds.length;
  return {
    writer_id: 1000 + index,
    dc: dcIds[dcIndex],
    endpoint: endpointAddr(dcIndex, index % endpointsPerDc[dcIndex]),
    generation: 7,
    // Every writer was `active` on all three VPS.
    state: "active",
    bound_clients: r.int(0, 31),
    rtt_ema_ms: rtt,
    degraded: index < degradedWriterCount,
    // draining was 0 everywhere; the drain_* fields are the null branch.
    draining: false,
    allow_drain_fallback: true,
    drain_deadline_epoch_secs: null,
    drain_over_ttl: false,
    drain_started_at_epoch_secs: null,
    idle_for_secs: r.int(0, 900),
    in_desired_map: true,
    matches_active_generation: true,
  };
}

// meWriters — 46 writers × 16 fields, the collection whose generic flatten
// produced ~1091 KV rows (§8, §22) and the reason EntityListSection exists.
export const meWriters: MeWritersData = (() => {
  const r = rng(0x33ee);
  // RTT walked across the documented 4–473 ms so both ends are represented.
  const rtts = spread(writerCount, 4, 473);
  return {
    middle_proxy_enabled: true,
    generated_at_epoch_secs: 1756000000,
    summary: {
      configured_dc_groups: dcIds.length,
      configured_endpoints: endpointsPerDc.reduce((a, b) => a + b, 0),
      available_endpoints: endpointsPerDc.reduce((a, b) => a + b, 0),
      available_pct: 100,
      required_writers: 44,
      alive_writers: writerCount,
      coverage_pct: 100,
      fresh_alive_writers: writerCount,
      fresh_coverage_pct: 100,
    },
    writers: times(writerCount, (i) => makeWriter(i, r, rtts[i])),
  };
})();

// summary — GET /v1/stats/summary (§6): both *_by_class breakdowns carried
// three entries on every VPS, with the exact class names observed.
export const connectionsBadByClass: ClassCount[] = [
  { class: "direct_modes_disabled", total: 412 },
  { class: "tls_handshake_bad_client", total: 87 },
  { class: "tls_mtproto_bad_client", total: 23 },
];

export const handshakeFailuresByClass: ClassCount[] = [
  { class: "expected_64_got_0_connection_reset", total: 156 },
  { class: "expected_64_got_0_unexpected_eof", total: 64 },
  { class: "timeout", total: 19 },
];

export const summary: StatsSummary = {
  uptime_seconds: 864321,
  connections_total: 184622,
  connections_bad_total: 522,
  handshake_timeouts_total: 19,
  configured_users: 37,
  connections_bad_by_class: connectionsBadByClass,
  handshake_failures_by_class: handshakeFailuresByClass,
};

// upstreamDcRows — the five DC rows nested inside the single upstream (§7),
// latency 4–493 ms.
const upstreamDcRows = spread(5, 4, 493).map((latency, i) => ({
  dc: dcIds[i],
  latency_ema_ms: latency,
  ip_preference: i % 2 === 0 ? "v4" : "v6",
}));

// upstreams — GET /v1/stats/upstreams (§7): one healthy direct upstream
// with five nested DC rows, exactly what all three VPS reported.
export const upstreams: UpstreamsData = {
  enabled: true,
  generated_at_epoch_secs: 1756000000,
  zero: {
    connect_attempt_total: 8123,
    connect_success_total: 8098,
    connect_fail_total: 25,
    connect_failfast_hard_error_total: 3,
    connect_attempts_bucket_1: 8000,
    connect_attempts_bucket_2: 98,
    connect_attempts_bucket_3_4: 20,
    connect_attempts_bucket_gt_4: 5,
    connect_duration_success_bucket_le_100ms: 7000,
    connect_duration_success_bucket_101_500ms: 1000,
    connect_duration_success_bucket_501_1000ms: 90,
    connect_duration_success_bucket_gt_1000ms: 8,
    connect_duration_fail_bucket_le_100ms: 10,
    connect_duration_fail_bucket_101_500ms: 8,
    connect_duration_fail_bucket_501_1000ms: 5,
    connect_duration_fail_bucket_gt_1000ms: 2,
  },
  summary: {
    configured_total: 1,
    healthy_total: 1,
    unhealthy_total: 0,
    direct_total: 1,
    socks4_total: 0,
    socks5_total: 0,
    shadowsocks_total: 0,
  },
  upstreams: [
    {
      upstream_id: 0,
      route_kind: "direct",
      address: "direct",
      weight: 1,
      scopes: "all",
      healthy: true,
      fails: 0,
      last_check_age_secs: 12,
      effective_latency_ms: 41,
      dc: upstreamDcRows,
    },
  ],
};

// upstreamQuality — GET /v1/runtime/upstream-quality (§7). Same upstream
// entity and same nested dc[], which is why §23.5 merges the two by
// upstream_id instead of rendering "Upstream #0" twice.
export const upstreamQuality: RuntimeUpstreamQualityData = {
  enabled: true,
  generated_at_epoch_secs: 1756000000,
  policy: {
    connect_retry_attempts: 3,
    connect_retry_backoff_ms: 120,
    connect_budget_ms: 5000,
    unhealthy_fail_threshold: 3,
    connect_failfast_hard_errors: true,
  },
  counters: {
    connect_attempt_total: 8123,
    connect_success_total: 8098,
    connect_fail_total: 25,
    connect_failfast_hard_error_total: 3,
  },
  summary: upstreams.summary,
  upstreams: [
    {
      upstream_id: 0,
      route_kind: "direct",
      address: "direct",
      weight: 1,
      scopes: "all",
      healthy: true,
      fails: 0,
      last_check_age_secs: 12,
      effective_latency_ms: 41,
      dc: upstreamDcRows,
    },
  ],
};

// --- zero/all counters (§11) -------------------------------------------
//
// Row arithmetic, pinned by the inventory test because the whole Counters
// Details page (§23.4) is sized by it:
//   core         21 scalars + 2 class arrays (2 entries each)  = 25 rows
//   upstream     16 scalars                                    = 16 rows
//   middle_proxy 54 scalars + empty handshake_error_codes       = 55 rows
//   pool         11 scalars                                    = 11 rows
//   desync        8 scalars                                    =  8 rows
//                                                          total 115 rows

function counterBlock(prefix: string, count: number, seed: number): Record<string, number> {
  const r = rng(seed);
  const out: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    // Deliberately a mix of zero and non-zero: the page's "non-zero only"
    // filter needs both sides to have something to do.
    out[`${prefix}_${i}_total`] = r.chance(0.3) ? 0 : r.int(1, 500000);
  }
  return out;
}

export const zeroCoreScalarCount = 21;
export const zeroUpstreamCount = 16;
export const zeroMiddleProxyCount = 55;
export const zeroPoolCount = 11;
export const zeroDesyncCount = 8;

// zeroAll — the forward-compatible counter dump. Typed as the generated
// client's ZeroAllData shape (`Record<string, unknown>` per section), which
// is what makes the generic fallback renderer necessary in the first place.
export const zeroAll = {
  generated_at_epoch_secs: 1756000000,
  core: {
    ...counterBlock("core", zeroCoreScalarCount, 0xc0e1),
    // The same {class,total} breakdown shape stats/summary carries, two
    // entries each here (§11: "внутри core повторяются массивы").
    connections_bad_by_class: connectionsBadByClass.slice(0, 2),
    handshake_failures_by_class: handshakeFailuresByClass.slice(0, 2),
  },
  upstream: counterBlock("upstream", zeroUpstreamCount, 0x0951),
  middle_proxy: {
    ...counterBlock("me", zeroMiddleProxyCount - 1, 0x3e12),
    // Empty on every VPS — the "empty is not absent" case §23.4 calls out
    // by name, and the one array that must not render as "0 items".
    handshake_error_codes: [] as unknown[],
  },
  pool: counterBlock("pool", zeroPoolCount, 0x9001),
  desync: counterBlock("desync", zeroDesyncCount, 0xde51),
};

// --- minimal/all (§10) --------------------------------------------------

// meRuntimeFieldNames mirrors internal/telemt.MinimalMeRuntimeData's json
// tags one-for-one — the ~55-field tuning-knob dump §10 describes. Listed
// explicitly (rather than generated) so a Telemt version bump that adds a
// knob shows up as a diff here, per §26's re-check list.
const meRuntimeFieldNames = [
  "active_generation", "warm_generation", "pending_hardswap_generation", "pending_hardswap_age_secs",
  "hardswap_enabled", "floor_mode", "adaptive_floor_idle_secs", "adaptive_floor_min_writers_single_endpoint",
  "adaptive_floor_min_writers_multi_endpoint", "adaptive_floor_recover_grace_secs",
  "adaptive_floor_writers_per_core_total", "adaptive_floor_cpu_cores_override",
  "adaptive_floor_max_extra_writers_single_per_core", "adaptive_floor_max_extra_writers_multi_per_core",
  "adaptive_floor_max_active_writers_per_core", "adaptive_floor_max_warm_writers_per_core",
  "adaptive_floor_max_active_writers_global", "adaptive_floor_max_warm_writers_global",
  "adaptive_floor_cpu_cores_detected", "adaptive_floor_cpu_cores_effective", "adaptive_floor_global_cap_raw",
  "adaptive_floor_global_cap_effective", "adaptive_floor_target_writers_total",
  "adaptive_floor_active_cap_configured", "adaptive_floor_active_cap_effective",
  "adaptive_floor_warm_cap_configured", "adaptive_floor_warm_cap_effective",
  "adaptive_floor_active_writers_current", "adaptive_floor_warm_writers_current", "me_keepalive_enabled",
  "me_keepalive_interval_secs", "me_keepalive_jitter_secs", "me_keepalive_payload_random",
  "rpc_proxy_req_every_secs", "me_reconnect_max_concurrent_per_dc", "me_reconnect_backoff_base_ms",
  "me_reconnect_backoff_cap_ms", "me_reconnect_fast_retry_count", "me_pool_drain_ttl_secs",
  "me_pool_force_close_secs", "me_pool_min_fresh_ratio", "me_bind_stale_mode", "me_bind_stale_ttl_secs",
  "me_single_endpoint_shadow_writers", "me_single_endpoint_outage_mode_enabled",
  "me_single_endpoint_outage_disable_quarantine", "me_single_endpoint_outage_backoff_min_ms",
  "me_single_endpoint_outage_backoff_max_ms", "me_single_endpoint_shadow_rotate_every_secs",
  "me_deterministic_writer_sort", "me_writer_pick_mode", "me_writer_pick_sample_size",
  "me_socks_kdf_policy", "quarantined_endpoints_total", "quarantined_endpoints",
] as const;

export const meRuntime: RuntimeMinimalMeRuntime = (() => {
  const r = rng(0x5171);
  const out: Record<string, unknown> = {};
  for (const name of meRuntimeFieldNames) {
    if (name === "quarantined_endpoints") {
      // Non-empty here (§26 asks whether this ever shows up populated) —
      // the edges module carries the absent/empty variants.
      out[name] = [{ endpoint: endpointAddr(0, 0), remaining_ms: 4200 }];
    } else if (name.endsWith("_mode") || name.endsWith("_policy")) {
      out[name] = "adaptive";
    } else if (name.endsWith("_enabled") || name.endsWith("_random") || name.endsWith("_sort")) {
      out[name] = r.chance(0.5);
    } else {
      out[name] = r.int(0, 4096);
    }
  }
  return out;
})();

// networkPath — five per-DC selected paths (§10).
export const networkPath: RuntimeMinimalDcPath[] = times(5, (i) => ({
  dc: dcIds[i],
  ip_preference: i % 2 === 0 ? "v4" : "v6",
  selected_addr_v4: `198.51.100.${20 + i}:8443`,
  // 2001:db8::/32 is the RFC 3849 documentation prefix.
  selected_addr_v6: i % 2 === 0 ? undefined : `[2001:db8::${i}]:8443`,
}));

// minimalAll — the composite endpoint (§10). It re-carries me_writers and
// dcs on purpose: that duplication is exactly why §10 warns against
// rendering this endpoint as one generic tree.
export const minimalAll: RuntimeMinimalAll = {
  me_writers: meWriters,
  dcs,
  me_runtime: meRuntime,
  network_path: networkPath,
};

export const meRuntimeFieldCount = meRuntimeFieldNames.length;
