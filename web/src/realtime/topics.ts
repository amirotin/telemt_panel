// Hand-written types for the hub's SSE/`/api/snapshot` topic payloads
// (internal/hub/hub.go, mirrored field-for-field from its json tags —
// task-2-report.md). These shapes are NOT part of api/openapi.yaml (the SSE
// endpoints are documented there only as opaque `text/event-stream`/
// `additionalProperties: true`), so hey-api's codegen has nothing to
// generate for them; only the `stats` topic is typed here since it's all
// Task 4's status strip needs — Tasks 5-8 extend this file with
// `users`/`runtime`/`upstreams`/`security`/`update` as their widgets need
// them, rather than each hand-rolling its own copy.

// Gated mirrors Telemt's generic Gated[T] wrapper (07-telemt-sdk.md).
// internal/telemt.Gated's Go field is `Data *T `json:"data,omitempty"`` —
// the key is OMITTED entirely when the gate is off (Go's omitempty on a nil
// pointer), never sent as an explicit JSON null. `data?` here matches that:
// every consumer must treat `undefined` and `null` the same (both mean "no
// data"), which resolveGated (pulse/widgets/gated.ts) already does via its
// falsy `!gated.data` check.
export interface Gated<T> {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs?: number;
  data?: T | null;
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
  /** GET /v1/system/info's config-reload pair (hub.go's statsSnapshot): the count is omitted at zero, the timestamp only arrives once a reload has happened. */
  config_reload_count?: number;
  last_config_reload_epoch_secs?: number;
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
  servers: { configured: string[]; live: string[]; live_total: number };
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
  events: RuntimeEdgeEventRecord[];
}

// RuntimeMinimalDcPath is one DC's selected network path
// (internal/telemt.MinimalDcPathData) — part of the "minimal" runtime
// group's per-DC breakdown (mini-task 2c).
export interface RuntimeMinimalDcPath {
  dc: number;
  ip_preference?: string;
  selected_addr_v4?: string;
  selected_addr_v6?: string;
}

// RuntimeMinimalMeRuntime mirrors internal/telemt.MinimalMeRuntimeData — a
// ~50-field ME pool tuning-knob dump. Typed loosely (matching
// EffectiveMiddleProxyLimits' precedent below) since its only consumer is
// diag/rows.ts's flattenToRows, not a curated field-by-field render — no
// call site needs individual field names.
export type RuntimeMinimalMeRuntime = Record<string, unknown>;

// RuntimeMinimalAll is the Gated[T] payload of GET /v1/stats/minimal/all
// (internal/telemt.MinimalAllPayload), carried by the "runtime" topic's
// `minimal` field (mini-task 2c). me_writers/dcs duplicate what the
// "upstreams" topic's own me_writers/dcs fields already carry — only
// me_runtime/network_path are new information the panel had no other
// source for.
export interface RuntimeMinimalAll {
  me_writers: MeWritersData;
  dcs: DcStatusData;
  me_runtime?: RuntimeMinimalMeRuntime;
  network_path: RuntimeMinimalDcPath[];
}

export interface RuntimeUpstreamQualityPolicy {
  connect_retry_attempts: number;
  connect_retry_backoff_ms: number;
  connect_budget_ms: number;
  unhealthy_fail_threshold: number;
  connect_failfast_hard_errors: boolean;
}

export interface RuntimeUpstreamQualityCounters {
  connect_attempt_total: number;
  connect_success_total: number;
  connect_fail_total: number;
  connect_failfast_hard_error_total: number;
}

export interface RuntimeUpstreamQualitySummary {
  configured_total: number;
  healthy_total: number;
  unhealthy_total: number;
  direct_total: number;
  socks4_total: number;
  socks5_total: number;
  shadowsocks_total: number;
}

export interface RuntimeUpstreamQualityDc {
  dc: number;
  latency_ema_ms: number | null;
  ip_preference: string;
}

export interface RuntimeUpstreamQualityUpstream {
  upstream_id: number;
  route_kind: string;
  address: string;
  weight: number;
  scopes: string;
  healthy: boolean;
  fails: number;
  last_check_age_secs: number;
  effective_latency_ms: number | null;
  dc: RuntimeUpstreamQualityDc[];
}

// RuntimeUpstreamQualityData is the "runtime" topic's `upstream_quality`
// field (internal/telemt.RuntimeUpstreamQualityData, mini-task 2c) — a
// bespoke flat shape, NOT Gated[T] (policy/counters always present
// alongside enabled/reason; summary/upstreams independently optional).
export interface RuntimeUpstreamQualityData {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  policy: RuntimeUpstreamQualityPolicy;
  counters: RuntimeUpstreamQualityCounters;
  summary?: RuntimeUpstreamQualitySummary;
  upstreams?: RuntimeUpstreamQualityUpstream[];
}

// RuntimeTopic mirrors hub.go's runtimeSnapshot. `minimal`/`upstream_quality`
// are always attempted (unlike recent_events, which is capability-gated) —
// their JSON keys are always present, `null` only when that poll's sub-call
// itself failed. recent_events is present only when runtime_edge is on
// (Go's omitempty on a nil pointer) — absent from the wire, not null, so
// it's typed optional rather than nullable.
export interface RuntimeTopic {
  gates: RuntimeGates | null;
  initialization: RuntimeInitialization | null;
  me_pool_state: Gated<RuntimeMePoolState> | null;
  me_quality: Gated<RuntimeMeQuality> | null;
  nat_stun: Gated<RuntimeNatStun> | null;
  me_selftest: Gated<RuntimeMeSelftest> | null;
  minimal: Gated<RuntimeMinimalAll> | null;
  upstream_quality: RuntimeUpstreamQualityData | null;
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
  dcs: DcStatus[];
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

// SecurityTopic mirrors hub.go's securitySnapshot.
//
// TLS fingerprints are deliberately NOT part of this topic (M4 task 1 /
// owner ruling 2026-08-26): the live payload is ~120 KB per poll, so it is
// fetched on visit through GET /api/telemt/tls-fingerprints instead and
// typed from the generated client (`GatedTlsFingerprints`), not here.
export interface SecurityTopic {
  posture: SecurityPosture | null;
  whitelist: SecurityWhitelist | null;
  effective_limits: EffectiveLimits | null;
}

// UpdateTopicEvent mirrors internal/update/engine.go's runEventWire — the
// "update" topic is event-driven (hub.go's PublishUpdate), not polled, and
// carries only the single latest phase-transition across BOTH targets (the
// update engine holds one global lock, so at most one target is ever
// actually running); a consumer must check `.target` before treating this
// as progress for the target it cares about.
export interface UpdateTopicEvent {
  run_id: string;
  target: "telemt" | "panel";
  phase: "checking" | "downloading" | "verifying" | "staging" | "installing" | "restarting" | "health" | "done" | "rolling_back" | "rolled_back" | "failed";
  version_from?: string;
  version_to: string;
  started_at: string;
  finished_at?: string;
  detail?: string;
}


// --- "web" topic (hub.go's webSnapshot, M4 task 8b) ---------------------
//
// Telemt's own GET /v1/runtime/web/status is NOT gated — it answers 200 even
// with WEB off and reports the closure in `available`/`reason`. The hub wraps
// it in Gated[T] anyway so the browser keeps ONE way to render a closed
// source; `enabled` mirrors `available`, `reason` is Telemt's own token, and
// `data` is kept even behind a closed gate because lifecycle/listeners are
// what explain WHY it is closed.

/** One semaphore's occupancy in the runtime's `permits` table. */
export interface WebPermitStatus {
  used: number;
  available: number;
  capacity: number;
  closed: boolean;
}

/**
 * The permits table as it arrives: a Rust tuple array, i.e. pairs of
 * [name, status] — not a map. `webPagePayload` (diag/web.helpers.ts) is
 * where it becomes an object keyed by permit name, so the field catalog can
 * describe `permits.http_connections.used` rather than `permits[0][1].used`.
 */
export type WebPermitEntry = [string, WebPermitStatus];

/** The session/bootstrap registry plane. */
export interface WebManagerStatus {
  issuance_enabled: boolean;
  issuance_generation: number;
  shutdown: boolean;
  bootstraps: number;
  sessions: number;
  closed_tokens: number;
  closed_sessions: number;
  client_ips: number;
  profiles: number;
}

export interface WebStreamStatus {
  live: number;
  profiles: number;
  closed: boolean;
}

export interface WebBudgetStatus {
  queue_bytes: number;
  queue_items: number;
  control_bytes: number;
  control_items: number;
  websocket_bytes: number;
  high_water_bytes: number;
  owners: number;
  closed: boolean;
}

export interface WebSocketsStatus {
  entries: number;
  claims: number;
  evictions_in_flight: number;
  closed: boolean;
}

export interface WebLearningStatus {
  enabled: boolean;
  aggressiveness: string;
  epoch: number | null;
  entries: number;
  capacity: number;
  lifetime_secs: number;
  age_ms: number;
}

/**
 * The request-capture policy block. Typed loosely for the same reason
 * RuntimeMinimalMeRuntime is: it is a Telemt config table the panel neither
 * edits nor interprets, and a future key must survive to the unknown tail
 * rather than be dropped by a fixed interface.
 */
export type WebDebugPolicy = Record<string, unknown>;

export interface WebDebugStatus {
  policy: WebDebugPolicy;
  policy_generation: number;
  epoch: number;
  records: number;
  records_capacity: number;
  used_bytes: number;
  bytes_capacity: number;
  contention_drops: number;
  evictions: number;
  byte_truncations: number;
  earliest_seq: number | null;
  latest_seq: number | null;
}

/** The 47 process-deferred WEB limits, as a map for the same reason. */
export type WebLimits = Record<string, unknown>;

/**
 * The live process state. Every plane is nullable-but-always-present: `null`
 * means its try_lock was contended for THIS poll (and the plane's name is in
 * `partial`), which is a different thing from the plane being absent.
 */
export interface WebRuntimeStatus {
  runtime_instance: string;
  generation_id: number;
  limits: WebLimits;
  manager: WebManagerStatus | null;
  streams: WebStreamStatus | null;
  budget: WebBudgetStatus | null;
  websockets: WebSocketsStatus | null;
  learning: WebLearningStatus | null;
  debug: WebDebugStatus | null;
  permits: WebPermitEntry[];
  auxiliary_tasks: number;
  session_incarnations_created: number;
  session_incarnations_closed: number;
  streams_opened: number;
  streams_rejected: number;
  bytes_up: number;
  bytes_down: number;
  limit_hits: number;
  partial: string[];
}

export type WebLifecycle =
  | "starting"
  | "no_web_listener"
  | "running"
  | "draining"
  | "drained"
  | "deadline_exceeded";

export interface WebStatus {
  lifecycle: WebLifecycle | string;
  lifecycle_epoch: number;
  lifecycle_age_ms: number;
  available: boolean;
  /** Omitted while available; `runtime_released` is a reason, not a lifecycle. */
  reason?: string;
  listeners: string[];
  effective_config_enabled: boolean;
  runtime?: WebRuntimeStatus | null;
}

/** WebTopic mirrors hub.go's webSnapshot. */
export interface WebTopic {
  status: Gated<WebStatus> | null;
}
