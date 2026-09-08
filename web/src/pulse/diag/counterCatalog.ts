import type { Dict } from "../../i18n";
import type { FieldUnit, FormatterName } from "../formatting";

export interface CounterCatalogEntry {
  path: string;
  descriptionKey: string;
  format?: FormatterName;
  unit?: FieldUnit;
}

interface ResolvedCounterEntry {
  path: string;
  descriptionKey?: string;
  format?: FormatterName;
  unit?: FieldUnit;
}

export type CounterFamilyId =
  "errorsTotal" | "total" | "bytes" | "milliseconds" | "seconds" | "percent" | "count";

export type CounterLookupSource = "exact" | "wildcard" | "family" | "fallback";

export interface CounterLookupResult {
  source: CounterLookupSource;
  entry: ResolvedCounterEntry | null;
  family?: CounterFamilyId;
}

export interface CounterDescription {
  path: string;
  description: string;
  format?: FormatterName;
  unit?: FieldUnit;
}

interface CounterFamily {
  id: CounterFamilyId;
  test: RegExp;
  format?: FormatterName;
  unit?: FieldUnit;
}

const COUNTER_FAMILIES: readonly CounterFamily[] = [
  { id: "errorsTotal", test: /_(errors?|failures?|drops?|timeouts?)_total$/, format: "integer" },
  { id: "total", test: /_total$/, format: "integer" },
  { id: "bytes", test: /_(bytes|octets)$/, unit: "bytes" },
  { id: "milliseconds", test: /_ms$/, unit: "milliseconds" },
  { id: "seconds", test: /_(secs|seconds)$/, unit: "seconds" },
  { id: "percent", test: /_pct$/, unit: "percent" },
  { id: "count", test: /_(count|current|gauge)$/, format: "integer" },
];

export const COUNTER_CATALOG_ENTRIES: readonly CounterCatalogEntry[] = [
  { path: "core.uptime_seconds", descriptionKey: "counters.core.uptime_seconds", unit: "seconds" },
  {
    path: "core.connections_total",
    descriptionKey: "counters.core.connections_total",
    format: "integer",
  },
  {
    path: "core.connections_bad_total",
    descriptionKey: "counters.core.connections_bad_total",
    format: "integer",
  },
  {
    path: "core.connections_bad_by_class",
    descriptionKey: "counters.core.connections_bad_by_class",
  },
  {
    path: "core.handshake_failures_by_class",
    descriptionKey: "counters.core.handshake_failures_by_class",
  },
  {
    path: "core.handshake_failures_by_stage",
    descriptionKey: "counters.core.handshake_failures_by_stage",
  },
  {
    path: "core.handshake_timeouts_total",
    descriptionKey: "counters.core.handshake_timeouts_total",
    format: "integer",
  },
  {
    path: "core.accept_permit_timeout_total",
    descriptionKey: "counters.core.accept_permit_timeout_total",
    format: "integer",
  },
  {
    path: "core.configured_users",
    descriptionKey: "counters.core.configured_users",
    format: "integer",
  },
  {
    path: "core.telemetry_core_enabled",
    descriptionKey: "counters.core.telemetry_core_enabled",
    format: "boolean",
  },
  {
    path: "core.telemetry_user_enabled",
    descriptionKey: "counters.core.telemetry_user_enabled",
    format: "boolean",
  },
  {
    path: "core.telemetry_me_level",
    descriptionKey: "counters.core.telemetry_me_level",
    format: "enum",
  },
  {
    path: "core.conntrack_control_enabled",
    descriptionKey: "counters.core.conntrack_control_enabled",
    format: "boolean",
  },
  {
    path: "core.conntrack_control_available",
    descriptionKey: "counters.core.conntrack_control_available",
    format: "boolean",
  },
  {
    path: "core.conntrack_pressure_active",
    descriptionKey: "counters.core.conntrack_pressure_active",
    format: "boolean",
  },
  {
    path: "core.conntrack_event_queue_depth",
    descriptionKey: "counters.core.conntrack_event_queue_depth",
    format: "integer",
  },
  {
    path: "core.conntrack_rule_apply_ok",
    descriptionKey: "counters.core.conntrack_rule_apply_ok",
    format: "boolean",
  },
  {
    path: "core.conntrack_delete_attempt_total",
    descriptionKey: "counters.core.conntrack_delete_attempt_total",
    format: "integer",
  },
  {
    path: "core.conntrack_delete_success_total",
    descriptionKey: "counters.core.conntrack_delete_success_total",
    format: "integer",
  },
  {
    path: "core.conntrack_delete_not_found_total",
    descriptionKey: "counters.core.conntrack_delete_not_found_total",
    format: "integer",
  },
  {
    path: "core.conntrack_delete_error_total",
    descriptionKey: "counters.core.conntrack_delete_error_total",
    format: "integer",
  },
  {
    path: "core.conntrack_close_event_drop_total",
    descriptionKey: "counters.core.conntrack_close_event_drop_total",
    format: "integer",
  },
  {
    path: "upstream.connect_attempt_total",
    descriptionKey: "counters.upstream.connect_attempt_total",
    format: "integer",
  },
  {
    path: "upstream.connect_success_total",
    descriptionKey: "counters.upstream.connect_success_total",
    format: "integer",
  },
  {
    path: "upstream.connect_fail_total",
    descriptionKey: "counters.upstream.connect_fail_total",
    format: "integer",
  },
  {
    path: "upstream.connect_failfast_hard_error_total",
    descriptionKey: "counters.upstream.connect_failfast_hard_error_total",
    format: "integer",
  },
  {
    path: "upstream.connect_attempts_bucket_1",
    descriptionKey: "counters.upstream.connect_attempts_bucket_1",
    format: "integer",
  },
  {
    path: "upstream.connect_attempts_bucket_2",
    descriptionKey: "counters.upstream.connect_attempts_bucket_2",
    format: "integer",
  },
  {
    path: "upstream.connect_attempts_bucket_3_4",
    descriptionKey: "counters.upstream.connect_attempts_bucket_3_4",
    format: "integer",
  },
  {
    path: "upstream.connect_attempts_bucket_gt_4",
    descriptionKey: "counters.upstream.connect_attempts_bucket_gt_4",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_success_bucket_le_100ms",
    descriptionKey: "counters.upstream.connect_duration_success_bucket_le_100ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_success_bucket_101_500ms",
    descriptionKey: "counters.upstream.connect_duration_success_bucket_101_500ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_success_bucket_501_1000ms",
    descriptionKey: "counters.upstream.connect_duration_success_bucket_501_1000ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_success_bucket_gt_1000ms",
    descriptionKey: "counters.upstream.connect_duration_success_bucket_gt_1000ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_fail_bucket_le_100ms",
    descriptionKey: "counters.upstream.connect_duration_fail_bucket_le_100ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_fail_bucket_101_500ms",
    descriptionKey: "counters.upstream.connect_duration_fail_bucket_101_500ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_fail_bucket_501_1000ms",
    descriptionKey: "counters.upstream.connect_duration_fail_bucket_501_1000ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_fail_bucket_gt_1000ms",
    descriptionKey: "counters.upstream.connect_duration_fail_bucket_gt_1000ms",
    format: "integer",
  },
  {
    path: "middle_proxy.keepalive_sent_total",
    descriptionKey: "counters.middle_proxy.keepalive_sent_total",
    format: "integer",
  },
  {
    path: "middle_proxy.keepalive_failed_total",
    descriptionKey: "counters.middle_proxy.keepalive_failed_total",
    format: "integer",
  },
  {
    path: "middle_proxy.keepalive_pong_total",
    descriptionKey: "counters.middle_proxy.keepalive_pong_total",
    format: "integer",
  },
  {
    path: "middle_proxy.keepalive_timeout_total",
    descriptionKey: "counters.middle_proxy.keepalive_timeout_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_sent_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_sent_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_failed_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_failed_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_skipped_no_meta_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_skipped_no_meta_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_response_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_response_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_close_sent_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_close_sent_total",
    format: "integer",
  },
  {
    path: "middle_proxy.reconnect_attempt_total",
    descriptionKey: "counters.middle_proxy.reconnect_attempt_total",
    format: "integer",
  },
  {
    path: "middle_proxy.reconnect_success_total",
    descriptionKey: "counters.middle_proxy.reconnect_success_total",
    format: "integer",
  },
  {
    path: "middle_proxy.handshake_reject_total",
    descriptionKey: "counters.middle_proxy.handshake_reject_total",
    format: "integer",
  },
  {
    path: "middle_proxy.handshake_error_codes",
    descriptionKey: "counters.middle_proxy.handshake_error_codes",
  },
  {
    path: "middle_proxy.reader_eof_total",
    descriptionKey: "counters.middle_proxy.reader_eof_total",
    format: "integer",
  },
  {
    path: "middle_proxy.idle_close_by_peer_total",
    descriptionKey: "counters.middle_proxy.idle_close_by_peer_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_no_conn_total",
    descriptionKey: "counters.middle_proxy.route_drop_no_conn_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_channel_closed_total",
    descriptionKey: "counters.middle_proxy.route_drop_channel_closed_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_queue_full_total",
    descriptionKey: "counters.middle_proxy.route_drop_queue_full_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_queue_full_base_total",
    descriptionKey: "counters.middle_proxy.route_drop_queue_full_base_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_queue_full_high_total",
    descriptionKey: "counters.middle_proxy.route_drop_queue_full_high_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_batches_total",
    descriptionKey: "counters.middle_proxy.d2c_batches_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_batch_frames_total",
    descriptionKey: "counters.middle_proxy.d2c_batch_frames_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_batch_bytes_total",
    descriptionKey: "counters.middle_proxy.d2c_batch_bytes_total",
    unit: "bytes",
  },
  {
    path: "middle_proxy.d2c_flush_reason_queue_drain_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_queue_drain_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_batch_frames_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_batch_frames_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_batch_bytes_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_batch_bytes_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_max_delay_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_max_delay_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_ack_immediate_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_ack_immediate_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_close_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_close_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_data_frames_total",
    descriptionKey: "counters.middle_proxy.d2c_data_frames_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_ack_frames_total",
    descriptionKey: "counters.middle_proxy.d2c_ack_frames_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_payload_bytes_total",
    descriptionKey: "counters.middle_proxy.d2c_payload_bytes_total",
    unit: "bytes",
  },
  {
    path: "middle_proxy.d2c_write_mode_coalesced_total",
    descriptionKey: "counters.middle_proxy.d2c_write_mode_coalesced_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_write_mode_split_total",
    descriptionKey: "counters.middle_proxy.d2c_write_mode_split_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_quota_reject_pre_write_total",
    descriptionKey: "counters.middle_proxy.d2c_quota_reject_pre_write_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_quota_reject_post_write_total",
    descriptionKey: "counters.middle_proxy.d2c_quota_reject_post_write_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_frame_buf_shrink_total",
    descriptionKey: "counters.middle_proxy.d2c_frame_buf_shrink_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_frame_buf_shrink_bytes_total",
    descriptionKey: "counters.middle_proxy.d2c_frame_buf_shrink_bytes_total",
    unit: "bytes",
  },
  {
    path: "middle_proxy.socks_kdf_strict_reject_total",
    descriptionKey: "counters.middle_proxy.socks_kdf_strict_reject_total",
    format: "integer",
  },
  {
    path: "middle_proxy.socks_kdf_compat_fallback_total",
    descriptionKey: "counters.middle_proxy.socks_kdf_compat_fallback_total",
    format: "integer",
  },
  {
    path: "middle_proxy.endpoint_quarantine_total",
    descriptionKey: "counters.middle_proxy.endpoint_quarantine_total",
    format: "integer",
  },
  {
    path: "middle_proxy.kdf_drift_total",
    descriptionKey: "counters.middle_proxy.kdf_drift_total",
    format: "integer",
  },
  {
    path: "middle_proxy.kdf_port_only_drift_total",
    descriptionKey: "counters.middle_proxy.kdf_port_only_drift_total",
    format: "integer",
  },
  {
    path: "middle_proxy.hardswap_pending_reuse_total",
    descriptionKey: "counters.middle_proxy.hardswap_pending_reuse_total",
    format: "integer",
  },
  {
    path: "middle_proxy.hardswap_pending_ttl_expired_total",
    descriptionKey: "counters.middle_proxy.hardswap_pending_ttl_expired_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_outage_enter_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_outage_enter_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_outage_exit_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_outage_exit_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_outage_reconnect_attempt_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_outage_reconnect_attempt_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_outage_reconnect_success_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_outage_reconnect_success_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_quarantine_bypass_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_quarantine_bypass_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_shadow_rotate_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_shadow_rotate_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_shadow_rotate_skipped_quarantine_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_shadow_rotate_skipped_quarantine_total",
    format: "integer",
  },
  {
    path: "middle_proxy.floor_mode_switch_total",
    descriptionKey: "counters.middle_proxy.floor_mode_switch_total",
    format: "integer",
  },
  {
    path: "middle_proxy.floor_mode_switch_static_to_adaptive_total",
    descriptionKey: "counters.middle_proxy.floor_mode_switch_static_to_adaptive_total",
    format: "integer",
  },
  {
    path: "middle_proxy.floor_mode_switch_adaptive_to_static_total",
    descriptionKey: "counters.middle_proxy.floor_mode_switch_adaptive_to_static_total",
    format: "integer",
  },
  {
    path: "pool.pool_swap_total",
    descriptionKey: "counters.pool.pool_swap_total",
    format: "integer",
  },
  {
    path: "pool.pool_drain_active",
    descriptionKey: "counters.pool.pool_drain_active",
    format: "integer",
  },
  {
    path: "pool.pool_force_close_total",
    descriptionKey: "counters.pool.pool_force_close_total",
    format: "integer",
  },
  {
    path: "pool.pool_stale_pick_total",
    descriptionKey: "counters.pool.pool_stale_pick_total",
    format: "integer",
  },
  {
    path: "pool.writer_removed_total",
    descriptionKey: "counters.pool.writer_removed_total",
    format: "integer",
  },
  {
    path: "pool.writer_removed_unexpected_total",
    descriptionKey: "counters.pool.writer_removed_unexpected_total",
    format: "integer",
  },
  {
    path: "pool.refill_triggered_total",
    descriptionKey: "counters.pool.refill_triggered_total",
    format: "integer",
  },
  {
    path: "pool.refill_skipped_inflight_total",
    descriptionKey: "counters.pool.refill_skipped_inflight_total",
    format: "integer",
  },
  {
    path: "pool.refill_failed_total",
    descriptionKey: "counters.pool.refill_failed_total",
    format: "integer",
  },
  {
    path: "pool.writer_restored_same_endpoint_total",
    descriptionKey: "counters.pool.writer_restored_same_endpoint_total",
    format: "integer",
  },
  {
    path: "pool.writer_restored_fallback_total",
    descriptionKey: "counters.pool.writer_restored_fallback_total",
    format: "integer",
  },
  {
    path: "desync.secure_padding_invalid_total",
    descriptionKey: "counters.desync.secure_padding_invalid_total",
    format: "integer",
  },
  {
    path: "desync.desync_total",
    descriptionKey: "counters.desync.desync_total",
    format: "integer",
  },
  {
    path: "desync.desync_full_logged_total",
    descriptionKey: "counters.desync.desync_full_logged_total",
    format: "integer",
  },
  {
    path: "desync.desync_suppressed_total",
    descriptionKey: "counters.desync.desync_suppressed_total",
    format: "integer",
  },
  {
    path: "desync.desync_frames_bucket_0",
    descriptionKey: "counters.desync.desync_frames_bucket_0",
    format: "integer",
  },
  {
    path: "desync.desync_frames_bucket_1_2",
    descriptionKey: "counters.desync.desync_frames_bucket_1_2",
    format: "integer",
  },
  {
    path: "desync.desync_frames_bucket_3_10",
    descriptionKey: "counters.desync.desync_frames_bucket_3_10",
    format: "integer",
  },
  {
    path: "desync.desync_frames_bucket_gt_10",
    descriptionKey: "counters.desync.desync_frames_bucket_gt_10",
    format: "integer",
  },
  {
    path: "core.connections_bad_by_class.*.class",
    descriptionKey: "counters.class",
    format: "enum",
  },
  {
    path: "core.handshake_failures_by_class.*.class",
    descriptionKey: "counters.class",
    format: "enum",
  },
  {
    path: "core.connections_bad_by_class.*.total",
    descriptionKey: "counters.class_total",
    format: "integer",
  },
  {
    path: "core.handshake_failures_by_class.*.total",
    descriptionKey: "counters.class_total",
    format: "integer",
  },
  {
    path: "core.handshake_failures_by_stage.*.stage",
    descriptionKey: "counters.stage",
    format: "enum",
  },
  {
    path: "core.handshake_failures_by_stage.*.total",
    descriptionKey: "counters.stage_total",
    format: "integer",
  },
  {
    path: "middle_proxy.handshake_error_codes.*.code",
    descriptionKey: "counters.error_code",
    format: "integer",
  },
  {
    path: "middle_proxy.handshake_error_codes.*.total",
    descriptionKey: "counters.error_code_total",
    format: "integer",
  },
];

const EXACT_ENTRIES = new Map(
  COUNTER_CATALOG_ENTRIES.filter((entry) => !entry.path.includes("*")).map(
    (entry) => [entry.path, entry] as const,
  ),
);
const WILDCARD_ENTRIES = COUNTER_CATALOG_ENTRIES.filter((entry) => entry.path.includes("*"));

function splitCounterPath(path: string): string[] {
  return path.split(/[.[\]]+/).filter(Boolean);
}

function matchesCounterPattern(path: string, pattern: string): boolean {
  const actual = splitCounterPath(path);
  const expected = splitCounterPath(pattern);
  return (
    actual.length === expected.length &&
    expected.every((segment, index) => segment === "*" || segment === actual[index])
  );
}

function counterFamilyFor(path: string): CounterFamily | null {
  const segments = splitCounterPath(path);
  const last = segments[segments.length - 1] ?? "";
  return COUNTER_FAMILIES.find((family) => family.test.test(last)) ?? null;
}

export function resolveCounter(path: string): CounterLookupResult {
  const exact = EXACT_ENTRIES.get(path);
  if (exact) return { source: "exact", entry: exact };

  const wildcard = WILDCARD_ENTRIES.find((entry) => matchesCounterPattern(path, entry.path));
  if (wildcard) return { source: "wildcard", entry: wildcard };

  const family = counterFamilyFor(path);
  if (family) {
    return {
      source: "family",
      family: family.id,
      entry: { path, format: family.format, unit: family.unit },
    };
  }

  return { source: "fallback", entry: null };
}

export function describeCounter(path: string, s: Dict): CounterDescription {
  const result = resolveCounter(path);
  const entry = result.entry;
  let description = s.details.fields.fallback;
  if (result.source === "family" && result.family) {
    description = s.details.fields.families[result.family];
  } else if (entry?.descriptionKey) {
    const descriptions = s.details.fields.descriptions as unknown as Record<
      string,
      string | undefined
    >;
    description = descriptions[entry.descriptionKey] ?? s.details.fields.fallback;
  }
  return {
    path,
    description,
    ...(entry?.format ? { format: entry.format } : {}),
    ...(entry?.unit ? { unit: entry.unit } : {}),
  };
}
