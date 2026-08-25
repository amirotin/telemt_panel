// Hand-written types for the hub's SSE/`/api/snapshot` topic payloads
// (internal/hub/hub.go, mirrored field-for-field from its json tags —
// task-2-report.md). These shapes are NOT part of api/openapi.yaml (the SSE
// endpoints are documented there only as opaque `text/event-stream`/
// `additionalProperties: true`), so hey-api's codegen has nothing to
// generate for them; only the `stats` topic is typed here since it's all
// Task 4's status strip needs — Tasks 5-8 extend this file with
// `users`/`runtime`/`upstreams`/`security`/`update` as their widgets need
// them, rather than each hand-rolling its own copy.

// Gated mirrors Telemt's generic Gated[T] wrapper (07-telemt-sdk.md):
// `data` is explicitly null when the gate is off, never omitted.
export interface Gated<T> {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs?: number;
  data: T | null;
}

export interface StatsHealth {
  status: string;
  read_only: boolean;
}

export interface ClassCount {
  class: string;
  total: number;
}

export interface StatsSummary {
  uptime_seconds: number;
  connections_total: number;
  connections_bad_total: number;
  handshake_timeouts_total: number;
  configured_users: number;
  connections_bad_by_class?: ClassCount[];
  handshake_failures_by_class?: ClassCount[];
}

export interface StatsReady {
  ready: boolean;
  status: string;
  reason?: string;
  admission_open: boolean;
  healthy_upstreams: number;
  total_upstreams: number;
}

export interface RuntimeEdgeConnectionTotals {
  current_connections: number;
  current_connections_me: number;
  current_connections_direct: number;
  active_users: number;
}

export interface RuntimeEdgeConnectionUser {
  username: string;
  current_connections: number;
  total_octets: number;
}

// Task 4 only typed `totals`; Task 6's Активные сессии widget and
// Диагностика → Соединения page need the rest (cache/top/telemetry), so
// this is now the full payload of GET /v1/runtime/connections/summary.
export interface RuntimeEdgeConnectionsSummary {
  cache: { ttl_ms: number; served_from_cache: boolean; stale_cache_used: boolean };
  totals: RuntimeEdgeConnectionTotals;
  top: {
    limit: number;
    by_connections: RuntimeEdgeConnectionUser[];
    by_throughput: RuntimeEdgeConnectionUser[];
  };
  telemetry: { user_enabled: boolean; throughput_is_cumulative: boolean };
}

export interface StatsSnapshot {
  health: StatsHealth | null;
  summary: StatsSummary | null;
  ready: StatsReady | null;
  connections_summary?: Gated<RuntimeEdgeConnectionsSummary>;
  version?: string;
  uptime_seconds?: number;
}

// UserLinksWire mirrors api/openapi.yaml's UserLinks schema exactly (the
// generated `UserLinks` type in lib/api/generated/types.gen.ts has the same
// shape — re-declared here rather than imported so this file stays a
// self-contained mirror of the wire topic payload, matching this file's own
// convention for the other topics).
export interface UserLinksWire {
  classic: string[];
  secure: string[];
  tls: string[];
  tls_domains: Array<{ domain: string; link: string }>;
}

// UsersTopicUser mirrors internal/telemt.UserInfo's json tags exactly (the
// "users" topic publishes the raw Telemt list, task-2-report.md /
// hub.go's usersSnapshot) — NOT httpapi's composite `User` REST schema,
// which additionally merges a per-user `quota` object and `sub_url` in.
// Optional fields here are Go's `omitempty` string/pointer fields; the two
// *_list fields have no omitempty on the Go side (always present) but are
// typed nullable defensively since a nil Go slice marshals to `null`.
export interface UsersTopicUser {
  username: string;
  enabled: boolean;
  in_runtime: boolean;
  user_ad_tag?: string;
  max_tcp_conns?: number;
  expiration_rfc3339?: string;
  data_quota_bytes?: number;
  rate_limit_up_bps?: number;
  rate_limit_down_bps?: number;
  max_unique_ips?: number;
  current_connections: number;
  active_unique_ips: number;
  active_unique_ips_list: string[] | null;
  recent_unique_ips: number;
  recent_unique_ips_list: string[] | null;
  total_octets: number;
  links: UserLinksWire;
}

// UsersTopicQuotaEntry mirrors internal/telemt.QuotaEntry.
export interface UsersTopicQuotaEntry {
  data_quota_bytes: number;
  used_bytes: number;
  last_reset_epoch_secs: number;
}

// UsersTopic is the "users" topic's composite payload (hub.go's
// usersSnapshot): quota is an explicit JSON null (not omitted) when the
// quota capability is unsupported or the probe failed for this poll —
// quota_supported distinguishes "unsupported" from "supported but this
// particular user has no quota entry" (an absent key in the map).
export interface UsersTopic {
  users: UsersTopicUser[];
  quota: Record<string, UsersTopicQuotaEntry> | null;
  quota_supported: boolean;
}

// --- "runtime"/"upstreams"/"security" topics (hub.go's runtimeSnapshot/
// upstreamsSnapshot/securitySnapshot, task-2-report.md Deliverable A) — used
// by Task 6's Пульс widgets and Диагностика drill-down pages. Mirrors
// internal/telemt/types_runtime.go, types_runtime_edge.go,
// types_stats.go, types_security.go field-for-field (json tags), grouped by
// source struct to match the Go source's own organization for easy
// cross-checking.

export interface RuntimeGates {
  accepting_new_connections: boolean;
  conditional_cast_enabled: boolean;
  me_runtime_ready: boolean;
  me2dc_fallback_enabled: boolean;
  me2dc_fast_enabled: boolean;
  use_middle_proxy: boolean;
  route_mode: string;
  reroute_active: boolean;
  reroute_to_direct_at_epoch_secs?: number;
  reroute_reason?: string;
  startup_status: string;
  startup_stage: string;
  startup_progress_pct: number;
}

export interface RuntimeInitializationComponent {
  id: string;
  title: string;
  status: string;
  started_at_epoch_ms: number | null;
  finished_at_epoch_ms: number | null;
  duration_ms: number | null;
  attempts: number;
  details?: string;
}

export interface RuntimeInitializationMe {
  status: string;
  current_stage: string;
  progress_pct: number;
  init_attempt: number;
  retry_limit: string;
  last_error?: string;
}

export interface RuntimeInitialization {
  status: string;
  degraded: boolean;
  current_stage: string;
  progress_pct: number;
  started_at_epoch_secs: number;
  ready_at_epoch_secs?: number;
  total_elapsed_ms: number;
  transport_mode: string;
  me: RuntimeInitializationMe;
  components: RuntimeInitializationComponent[];
}

export interface RuntimeMePoolStateGenerations {
  active_generation: number;
  warm_generation: number;
  pending_hardswap_generation: number;
  pending_hardswap_age_secs: number | null;
  draining_generations: number[];
}

export interface RuntimeMePoolStateHardswap {
  enabled: boolean;
  pending: boolean;
}

export interface RuntimeMePoolStateWriters {
  total: number;
  alive_non_draining: number;
  draining: number;
  degraded: number;
  contour: { warm: number; active: number; draining: number };
  health: { healthy: number; degraded: number; draining: number };
}

export interface RuntimeMePoolStateRefillDc {
  dc: number;
  family: string;
  inflight: number;
}

export interface RuntimeMePoolStateRefill {
  inflight_endpoints_total: number;
  inflight_dc_total: number;
  by_dc: RuntimeMePoolStateRefillDc[];
}

export interface RuntimeMePoolState {
  generations: RuntimeMePoolStateGenerations;
  hardswap: RuntimeMePoolStateHardswap;
  writers: RuntimeMePoolStateWriters;
  refill: RuntimeMePoolStateRefill;
}

export interface RuntimeMeQualityCounters {
  idle_close_by_peer_total: number;
  reader_eof_total: number;
  kdf_drift_total: number;
  kdf_port_only_drift_total: number;
  reconnect_attempt_total: number;
  reconnect_success_total: number;
}

export interface RuntimeMeQualityRouteDrops {
  no_conn_total: number;
  channel_closed_total: number;
  queue_full_total: number;
  queue_full_base_total: number;
  queue_full_high_total: number;
}

export interface RuntimeMeQualityFamilyState {
  family: string;
  state: string;
  state_since_epoch_secs: number;
  suppressed_until_epoch_secs?: number;
  fail_streak: number;
  recover_success_streak: number;
}

export interface RuntimeMeQualityDrainGate {
  route_quorum_ok: boolean;
  redundancy_ok: boolean;
  block_reason: string;
  updated_at_epoch_secs: number;
}

export interface RuntimeMeQualityDcRtt {
  dc: number;
  rtt_ema_ms: number | null;
  alive_writers: number;
  required_writers: number;
  coverage_pct: number;
}

export interface RuntimeMeQuality {
  counters: RuntimeMeQualityCounters;
  route_drops: RuntimeMeQualityRouteDrops;
  family_states: RuntimeMeQualityFamilyState[];
  drain_gate: RuntimeMeQualityDrainGate;
  dc_rtt: RuntimeMeQualityDcRtt[];
}

export interface RuntimeNatStunReflection {
  addr: string;
  age_secs: number;
}

export interface RuntimeNatStun {
  flags: {
    nat_probe_enabled: boolean;
    nat_probe_disabled_runtime: boolean;
    nat_probe_attempts: number;
  };
  servers: { configured: string[] | null; live: string[] | null; live_total: number };
  reflection: { v4?: RuntimeNatStunReflection; v6?: RuntimeNatStunReflection };
  stun_backoff_remaining_ms?: number;
}

export interface RuntimeMeSelftestKdf {
  state: string;
  ewma_errors_per_min: number;
  threshold_errors_per_min: number;
  errors_total: number;
}

export interface RuntimeMeSelftestTimeskew {
  state: string;
  max_skew_secs_15m: number | null;
  samples_15m: number;
  last_skew_secs?: number;
  last_source?: string;
  last_seen_age_secs?: number;
}

export interface RuntimeMeSelftestIpFamily {
  addr: string;
  state: string;
}

export interface RuntimeMeSelftestBnd {
  addr_state: string;
  port_state: string;
  last_addr?: string;
  last_seen_age_secs?: number;
}

export interface RuntimeMeSelftestUpstream {
  upstream_id: number;
  route_kind: string;
  address: string;
  bnd?: RuntimeMeSelftestBnd;
  ip?: string;
}

export interface RuntimeMeSelftest {
  kdf: RuntimeMeSelftestKdf;
  timeskew: RuntimeMeSelftestTimeskew;
  ip: { v4?: RuntimeMeSelftestIpFamily; v6?: RuntimeMeSelftestIpFamily };
  pid: { pid: number; state: string };
  bnd: RuntimeMeSelftestBnd | null;
  upstreams?: RuntimeMeSelftestUpstream[];
}

export interface RuntimeEdgeEventRecord {
  seq: number;
  ts_epoch_secs: number;
  event_type: string;
  context: string;
}

export interface RuntimeEdgeEvents {
  capacity: number;
  dropped_total: number;
  events: RuntimeEdgeEventRecord[] | null;
}

// RuntimeTopic mirrors hub.go's runtimeSnapshot. recent_events is present
// only when runtime_edge is on (Go's omitempty on a nil pointer) — absent
// from the wire, not null, so it's typed optional rather than nullable.
export interface RuntimeTopic {
  gates: RuntimeGates | null;
  initialization: RuntimeInitialization | null;
  me_pool_state: Gated<RuntimeMePoolState> | null;
  me_quality: Gated<RuntimeMeQuality> | null;
  nat_stun: Gated<RuntimeNatStun> | null;
  me_selftest: Gated<RuntimeMeSelftest> | null;
  recent_events?: Gated<RuntimeEdgeEvents>;
}

export interface UpstreamDcRow {
  dc: number;
  latency_ema_ms: number | null;
  ip_preference: string;
}

export interface UpstreamStatus {
  upstream_id: number;
  route_kind: string;
  address: string;
  weight: number;
  scopes: string;
  healthy: boolean;
  fails: number;
  last_check_age_secs: number;
  effective_latency_ms: number | null;
  dc: UpstreamDcRow[];
}

export interface UpstreamSummary {
  configured_total: number;
  healthy_total: number;
  unhealthy_total: number;
  direct_total: number;
  socks4_total: number;
  socks5_total: number;
  shadowsocks_total: number;
}

export interface ZeroUpstream {
  connect_attempt_total: number;
  connect_success_total: number;
  connect_fail_total: number;
  connect_failfast_hard_error_total: number;
  connect_attempts_bucket_1: number;
  connect_attempts_bucket_2: number;
  connect_attempts_bucket_3_4: number;
  connect_attempts_bucket_gt_4: number;
  connect_duration_success_bucket_le_100ms: number;
  connect_duration_success_bucket_101_500ms: number;
  connect_duration_success_bucket_501_1000ms: number;
  connect_duration_success_bucket_gt_1000ms: number;
  connect_duration_fail_bucket_le_100ms: number;
  connect_duration_fail_bucket_101_500ms: number;
  connect_duration_fail_bucket_501_1000ms: number;
  connect_duration_fail_bucket_gt_1000ms: number;
}

export interface UpstreamsData {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  zero: ZeroUpstream;
  summary?: UpstreamSummary;
  upstreams?: UpstreamStatus[];
}

export interface DcEndpointWriters {
  endpoint: string;
  active_writers: number;
}

export interface DcStatus {
  dc: number;
  endpoints: string[];
  endpoint_writers: DcEndpointWriters[];
  available_endpoints: number;
  available_pct: number;
  required_writers: number;
  floor_min: number;
  floor_target: number;
  floor_max: number;
  floor_capped: boolean;
  alive_writers: number;
  coverage_pct: number;
  fresh_alive_writers: number;
  fresh_coverage_pct: number;
  rtt_ms: number | null;
  load: number;
}

export interface DcStatusData {
  middle_proxy_enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  dcs: DcStatus[] | null;
}

export interface MeWriterStatus {
  writer_id: number;
  dc: number | null;
  endpoint: string;
  generation: number;
  state: string;
  draining: boolean;
  degraded: boolean;
  bound_clients: number;
  idle_for_secs: number | null;
  rtt_ema_ms: number | null;
  matches_active_generation: boolean;
  in_desired_map: boolean;
  allow_drain_fallback: boolean;
  drain_started_at_epoch_secs: number | null;
  drain_deadline_epoch_secs: number | null;
  drain_over_ttl: boolean;
}

export interface MeWritersSummary {
  configured_dc_groups: number;
  configured_endpoints: number;
  available_endpoints: number;
  available_pct: number;
  required_writers: number;
  alive_writers: number;
  coverage_pct: number;
  fresh_alive_writers: number;
  fresh_coverage_pct: number;
}

export interface MeWritersData {
  middle_proxy_enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  summary: MeWritersSummary;
  writers: MeWriterStatus[];
}

// UpstreamsTopic mirrors hub.go's upstreamsSnapshot.
export interface UpstreamsTopic {
  upstreams: UpstreamsData | null;
  dcs: DcStatusData | null;
  me_writers: MeWritersData | null;
}

export interface SecurityPosture {
  api_read_only: boolean;
  api_whitelist_enabled: boolean;
  api_whitelist_entries: number;
  api_auth_header_enabled: boolean;
  proxy_protocol_enabled: boolean;
  log_level: string;
  telemetry_core_enabled: boolean;
  telemetry_user_enabled: boolean;
  telemetry_me_level: string;
}

export interface SecurityWhitelist {
  generated_at_epoch_secs: number;
  enabled: boolean;
  entries_total: number;
  entries: string[];
}

export interface EffectiveTimeoutLimits {
  client_first_byte_idle_secs: number;
  client_handshake_secs: number;
  tg_connect_secs: number;
  client_keepalive_secs: number;
  client_ack_secs: number;
  me_one_retry: number;
  me_one_timeout_ms: number;
}

export interface EffectiveUpstreamLimits {
  connect_retry_attempts: number;
  connect_retry_backoff_ms: number;
  connect_budget_ms: number;
  unhealthy_fail_threshold: number;
  connect_failfast_hard_errors: boolean;
}

export interface EffectiveUserIPPolicyLimits {
  global_each: number;
  mode: string;
  window_secs: number;
}

export interface EffectiveUserTCPPolicyLimits {
  global_each: number;
}

// EffectiveMiddleProxyLimits' fields are deliberately typed loosely
// (Record<string, unknown>) rather than field-for-field like the rest of
// this file — it is a ~20-field internal tuning-knob dump
// (internal/telemt/types_runtime.go's EffectiveMiddleProxyLimits) the
// diagnostics page renders generically (pulse/diag/rows.ts's flattenToRows),
// so there is no call site that needs individual field names typed.
export type EffectiveMiddleProxyLimits = Record<string, unknown>;

export interface EffectiveLimits {
  update_every_secs: number;
  me_reinit_every_secs: number;
  me_pool_force_close_secs: number;
  timeouts: EffectiveTimeoutLimits;
  upstream: EffectiveUpstreamLimits;
  middle_proxy: EffectiveMiddleProxyLimits;
  user_ip_policy: EffectiveUserIPPolicyLimits;
  user_tcp_policy: EffectiveUserTCPPolicyLimits;
}

export interface RuntimeEdgeTLSFingerprintRow {
  scope?: string;
  ja3: string;
  ja3_raw: string;
  ja4: string;
  ja4_raw: string;
  total: number;
  auth_success: number;
  bad_or_probe: number;
  first_seen_epoch_secs: number;
  last_seen_epoch_secs: number;
}

export interface RuntimeEdgeTLSFingerprints {
  limit: number;
  retention_secs: number;
  capacity: number;
  dropped_total: number;
  parse_error_total: number;
  by_fingerprint: RuntimeEdgeTLSFingerprintRow[] | null;
  by_ip: RuntimeEdgeTLSFingerprintRow[] | null;
  by_cidr: RuntimeEdgeTLSFingerprintRow[] | null;
  by_user: RuntimeEdgeTLSFingerprintRow[] | null;
}

// SecurityTopic mirrors hub.go's securitySnapshot. tls_fingerprints is
// present only when runtime_edge is on — same omitempty rule as
// RuntimeTopic.recent_events.
export interface SecurityTopic {
  posture: SecurityPosture | null;
  whitelist: SecurityWhitelist | null;
  effective_limits: EffectiveLimits | null;
  tls_fingerprints?: Gated<RuntimeEdgeTLSFingerprints>;
}

