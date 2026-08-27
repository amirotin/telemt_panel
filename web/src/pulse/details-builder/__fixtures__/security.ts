// Production-size fixtures for the security family: posture, whitelist,
// effective limits and the four TLS fingerprint rankings.
// TELEMT_LIVE_API_DATA.md §12, §19–20.
import type { EffectiveLimits, SecurityPosture, SecurityWhitelist } from "../../../realtime/topics";
import type { TlsFingerprintRow, TlsFingerprints } from "../../../lib/api/generated/types.gen";
import { rng, times } from "./seed";

export const posture: SecurityPosture = {
  api_read_only: false,
  api_whitelist_enabled: true,
  api_whitelist_entries: 1,
  api_auth_header_enabled: true,
  proxy_protocol_enabled: false,
  log_level: "info",
  telemetry_core_enabled: true,
  telemetry_user_enabled: true,
  telemetry_me_level: "basic",
};

// whitelist — one entry on every VPS (§20); the real value is not recorded
// in the source document, so this is a documentation-range address.
export const whitelist: SecurityWhitelist = {
  generated_at_epoch_secs: 1756000000,
  enabled: true,
  entries_total: 1,
  entries: ["198.51.100.0/24"],
};

// effectiveLimits — 40 leaf values at depth 2 (§12). The middle_proxy group
// carries the 21 tuning knobs internal/telemt.EffectiveMiddleProxyLimits
// declares; 3 + 7 + 5 + 21 + 3 + 1 = 40, pinned by the inventory test.
export const effectiveLimits: EffectiveLimits = {
  update_every_secs: 5,
  me_reinit_every_secs: 900,
  me_pool_force_close_secs: 60,
  timeouts: {
    client_first_byte_idle_secs: 30,
    client_handshake_secs: 10,
    tg_connect_secs: 8,
    client_keepalive_secs: 60,
    client_ack_secs: 15,
    me_one_retry: 1,
    me_one_timeout_ms: 1500,
  },
  upstream: {
    connect_retry_attempts: 3,
    connect_retry_backoff_ms: 120,
    connect_budget_ms: 5000,
    unhealthy_fail_threshold: 3,
    connect_failfast_hard_errors: true,
  },
  middle_proxy: {
    floor_mode: "adaptive",
    adaptive_floor_idle_secs: 120,
    adaptive_floor_min_writers_single_endpoint: 2,
    adaptive_floor_min_writers_multi_endpoint: 3,
    adaptive_floor_recover_grace_secs: 30,
    adaptive_floor_writers_per_core_total: 4,
    adaptive_floor_cpu_cores_override: 0,
    adaptive_floor_max_extra_writers_single_per_core: 2,
    adaptive_floor_max_extra_writers_multi_per_core: 3,
    adaptive_floor_max_active_writers_per_core: 8,
    adaptive_floor_max_warm_writers_per_core: 4,
    adaptive_floor_max_active_writers_global: 64,
    adaptive_floor_max_warm_writers_global: 32,
    reconnect_max_concurrent_per_dc: 2,
    reconnect_backoff_base_ms: 250,
    reconnect_backoff_cap_ms: 8000,
    reconnect_fast_retry_count: 2,
    writer_pick_mode: "least_loaded",
    writer_pick_sample_size: 4,
    me2dc_fallback: true,
    me2dc_fast: false,
  },
  user_ip_policy: { global_each: 4, mode: "strict", window_secs: 3600 },
  user_tcp_policy: { global_each: 16 },
};

// --- TLS fingerprints (§19) ---------------------------------------------
//
// The largest single Telemt payload: ~120 KB, 1957 leaves, four lists of 50.
// by_fingerprint rows carry 9 fields; by_ip/by_cidr/by_user carry the same
// nine plus `scope` (the grouping key), i.e. 10 leaves per record.

export const tlsRowsPerScope = 50;

// JA3/JA4 in their real shapes: JA3 is a 32-hex-char MD5 over a
// comma/dash-joined cipher list; JA4 is the a_b_c triplet form. Values are
// synthesized, but the lengths and character classes are what the layout
// has to survive.
function hex32(r: ReturnType<typeof rng>): string {
  return times(32, () => "0123456789abcdef"[r.int(0, 15)]).join("");
}

function ja3Raw(r: ReturnType<typeof rng>): string {
  const ciphers = times(r.int(8, 16), () => r.int(4000, 65000)).join("-");
  const extensions = times(r.int(6, 12), () => r.int(0, 65)).join("-");
  return `771,${ciphers},${extensions},29-23-24,0`;
}

function ja4(r: ReturnType<typeof rng>): string {
  return `t13d${r.int(10, 19)}${r.int(10, 19)}h2_${hex32(r).slice(0, 12)}_${hex32(r).slice(0, 12)}`;
}

function makeRow(
  r: ReturnType<typeof rng>,
  total: number,
  scope: string | undefined,
): TlsFingerprintRow {
  const row: TlsFingerprintRow = {
    ja3: hex32(r),
    ja3_raw: ja3Raw(r),
    ja4: ja4(r),
    ja4_raw: `t13d1516h2_${hex32(r)}_${hex32(r)}`,
    total,
    // auth_success matched total across every observed range (§19's table:
    // identical bounds in both columns).
    auth_success: total,
    // bad_or_probe was 0 in every list on every VPS — §26 lists "did a
    // non-zero bad_or_probe appear?" as a thing to re-check on a bump.
    bad_or_probe: 0,
    first_seen_epoch_secs: 1755900000 + r.int(0, 50000),
    last_seen_epoch_secs: 1755990000 + r.int(0, 9000),
  };
  return scope === undefined ? row : { ...row, scope };
}

// Per-scope `total` ranges, straight from §19's table.
function scopeRows(seed: number, maxTotal: number, scopeFor?: (i: number) => string): TlsFingerprintRow[] {
  const r = rng(seed);
  // Descending totals from the documented maximum down to 1, so the
  // RankingSection's sort has a real gradient and both bounds appear.
  const step = (maxTotal - 1) / (tlsRowsPerScope - 1);
  return times(tlsRowsPerScope, (i) =>
    makeRow(r, Math.max(1, Math.round(maxTotal - step * i)), scopeFor?.(i)),
  );
}

export const tlsFingerprints: TlsFingerprints = {
  limit: tlsRowsPerScope,
  retention_secs: 900,
  capacity: 4096,
  dropped_total: 0,
  parse_error_total: 0,
  by_fingerprint: scopeRows(0x71a3, 3364),
  by_ip: scopeRows(0x71b1, 174, (i) => `203.0.113.${i + 1}`),
  by_cidr: scopeRows(0x71c1, 174, (i) => `203.0.113.${(i % 8) * 32}/27`),
  by_user: scopeRows(0x71d1, 194, (i) => `user_${String((i % 14) + 1).padStart(2, "0")}`),
};
