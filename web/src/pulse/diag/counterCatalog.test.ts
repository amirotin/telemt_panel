import { describe, expect, it } from "vitest";
import { en } from "../../i18n/en";
import { ru } from "../../i18n/ru";
import { zeroAll } from "../__fixtures__";
import {
  COUNTER_CATALOG_ENTRIES,
  describeCounter,
  resolveCounter,
  type CounterCatalogEntry,
} from "./counterCatalog";
import { COUNTER_DESCRIPTION_EXPECTATIONS } from "./__fixtures__/counterDescriptions";
import { scalarCounterRows } from "./counters.view.helpers";

const EXPECTED_ENTRIES: CounterCatalogEntry[] = [
  {
    path: "core.uptime_seconds",
    descriptionKey: "counters.core.uptime_seconds",
    unit: "seconds",
  },
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

const EXPECTED_ZERO_ALL_PATHS = [
  "core.core_0_total",
  "core.core_1_total",
  "core.core_2_total",
  "core.core_3_total",
  "core.core_4_total",
  "core.core_5_total",
  "core.core_6_total",
  "core.core_7_total",
  "core.core_8_total",
  "core.core_9_total",
  "core.core_10_total",
  "core.core_11_total",
  "core.core_12_total",
  "core.core_13_total",
  "core.core_14_total",
  "core.core_15_total",
  "core.core_16_total",
  "core.core_17_total",
  "core.core_18_total",
  "core.core_19_total",
  "core.core_20_total",
  "upstream.upstream_0_total",
  "upstream.upstream_1_total",
  "upstream.upstream_2_total",
  "upstream.upstream_3_total",
  "upstream.upstream_4_total",
  "upstream.upstream_5_total",
  "upstream.upstream_6_total",
  "upstream.upstream_7_total",
  "upstream.upstream_8_total",
  "upstream.upstream_9_total",
  "upstream.upstream_10_total",
  "upstream.upstream_11_total",
  "upstream.upstream_12_total",
  "upstream.upstream_13_total",
  "upstream.upstream_14_total",
  "upstream.upstream_15_total",
  "middle_proxy.me_0_total",
  "middle_proxy.me_1_total",
  "middle_proxy.me_2_total",
  "middle_proxy.me_3_total",
  "middle_proxy.me_4_total",
  "middle_proxy.me_5_total",
  "middle_proxy.me_6_total",
  "middle_proxy.me_7_total",
  "middle_proxy.me_8_total",
  "middle_proxy.me_9_total",
  "middle_proxy.me_10_total",
  "middle_proxy.me_11_total",
  "middle_proxy.me_12_total",
  "middle_proxy.me_13_total",
  "middle_proxy.me_14_total",
  "middle_proxy.me_15_total",
  "middle_proxy.me_16_total",
  "middle_proxy.me_17_total",
  "middle_proxy.me_18_total",
  "middle_proxy.me_19_total",
  "middle_proxy.me_20_total",
  "middle_proxy.me_21_total",
  "middle_proxy.me_22_total",
  "middle_proxy.me_23_total",
  "middle_proxy.me_24_total",
  "middle_proxy.me_25_total",
  "middle_proxy.me_26_total",
  "middle_proxy.me_27_total",
  "middle_proxy.me_28_total",
  "middle_proxy.me_29_total",
  "middle_proxy.me_30_total",
  "middle_proxy.me_31_total",
  "middle_proxy.me_32_total",
  "middle_proxy.me_33_total",
  "middle_proxy.me_34_total",
  "middle_proxy.me_35_total",
  "middle_proxy.me_36_total",
  "middle_proxy.me_37_total",
  "middle_proxy.me_38_total",
  "middle_proxy.me_39_total",
  "middle_proxy.me_40_total",
  "middle_proxy.me_41_total",
  "middle_proxy.me_42_total",
  "middle_proxy.me_43_total",
  "middle_proxy.me_44_total",
  "middle_proxy.me_45_total",
  "middle_proxy.me_46_total",
  "middle_proxy.me_47_total",
  "middle_proxy.me_48_total",
  "middle_proxy.me_49_total",
  "middle_proxy.me_50_total",
  "middle_proxy.me_51_total",
  "middle_proxy.me_52_total",
  "middle_proxy.me_53_total",
  "pool.pool_0_total",
  "pool.pool_1_total",
  "pool.pool_2_total",
  "pool.pool_3_total",
  "pool.pool_4_total",
  "pool.pool_5_total",
  "pool.pool_6_total",
  "pool.pool_7_total",
  "pool.pool_8_total",
  "pool.pool_9_total",
  "pool.pool_10_total",
  "desync.desync_0_total",
  "desync.desync_1_total",
  "desync.desync_2_total",
  "desync.desync_3_total",
  "desync.desync_4_total",
  "desync.desync_5_total",
  "desync.desync_6_total",
  "desync.desync_7_total",
];

const WILDCARD_INSTANCES = [
  {
    pattern: "core.connections_bad_by_class.*.class",
    path: "core.connections_bad_by_class[3].class",
    descriptionKey: "counters.class",
    format: "enum",
  },
  {
    pattern: "core.connections_bad_by_class.*.class",
    path: "core.connections_bad_by_class.3.class",
    descriptionKey: "counters.class",
    format: "enum",
  },
  {
    pattern: "core.handshake_failures_by_class.*.class",
    path: "core.handshake_failures_by_class[3].class",
    descriptionKey: "counters.class",
    format: "enum",
  },
  {
    pattern: "core.handshake_failures_by_class.*.class",
    path: "core.handshake_failures_by_class.3.class",
    descriptionKey: "counters.class",
    format: "enum",
  },
  {
    pattern: "core.connections_bad_by_class.*.total",
    path: "core.connections_bad_by_class[3].total",
    descriptionKey: "counters.class_total",
    format: "integer",
  },
  {
    pattern: "core.connections_bad_by_class.*.total",
    path: "core.connections_bad_by_class.3.total",
    descriptionKey: "counters.class_total",
    format: "integer",
  },
  {
    pattern: "core.handshake_failures_by_class.*.total",
    path: "core.handshake_failures_by_class[3].total",
    descriptionKey: "counters.class_total",
    format: "integer",
  },
  {
    pattern: "core.handshake_failures_by_class.*.total",
    path: "core.handshake_failures_by_class.3.total",
    descriptionKey: "counters.class_total",
    format: "integer",
  },
  {
    pattern: "core.handshake_failures_by_stage.*.stage",
    path: "core.handshake_failures_by_stage[3].stage",
    descriptionKey: "counters.stage",
    format: "enum",
  },
  {
    pattern: "core.handshake_failures_by_stage.*.stage",
    path: "core.handshake_failures_by_stage.3.stage",
    descriptionKey: "counters.stage",
    format: "enum",
  },
  {
    pattern: "core.handshake_failures_by_stage.*.total",
    path: "core.handshake_failures_by_stage[3].total",
    descriptionKey: "counters.stage_total",
    format: "integer",
  },
  {
    pattern: "core.handshake_failures_by_stage.*.total",
    path: "core.handshake_failures_by_stage.3.total",
    descriptionKey: "counters.stage_total",
    format: "integer",
  },
  {
    pattern: "middle_proxy.handshake_error_codes.*.code",
    path: "middle_proxy.handshake_error_codes[3].code",
    descriptionKey: "counters.error_code",
    format: "integer",
  },
  {
    pattern: "middle_proxy.handshake_error_codes.*.code",
    path: "middle_proxy.handshake_error_codes.3.code",
    descriptionKey: "counters.error_code",
    format: "integer",
  },
  {
    pattern: "middle_proxy.handshake_error_codes.*.total",
    path: "middle_proxy.handshake_error_codes[3].total",
    descriptionKey: "counters.error_code_total",
    format: "integer",
  },
  {
    pattern: "middle_proxy.handshake_error_codes.*.total",
    path: "middle_proxy.handshake_error_codes.3.total",
    descriptionKey: "counters.error_code_total",
    format: "integer",
  },
];

describe("counter catalog", () => {
  it("retains the literal 120-entry counter contract", () => {
    expect(COUNTER_CATALOG_ENTRIES).toEqual(EXPECTED_ENTRIES);
    expect(COUNTER_CATALOG_ENTRIES).toHaveLength(120);
    expect(new Set(COUNTER_CATALOG_ENTRIES.map((entry) => entry.path)).size).toBe(120);
    expect(new Set(COUNTER_CATALOG_ENTRIES.map((entry) => entry.descriptionKey)).size).toBe(118);
    expect(Object.keys(COUNTER_DESCRIPTION_EXPECTATIONS)).toHaveLength(118);
    expect(COUNTER_CATALOG_ENTRIES.filter((entry) => entry.path.includes("*"))).toHaveLength(8);
  });

  it.each([
    ["ru", ru],
    ["en", en],
  ] as const)("resolves every literal entry in %s with its exact metadata", (_locale, dict) => {
    for (const expected of EXPECTED_ENTRIES) {
      const path = expected.path.includes("*")
        ? expected.path.replace(".*.", "[3].")
        : expected.path;
      const resolved = resolveCounter(path);
      const descriptionKey = expected.descriptionKey as keyof typeof COUNTER_DESCRIPTION_EXPECTATIONS;
      expect(resolved.source, path).toBe(expected.path.includes("*") ? "wildcard" : "exact");
      expect(describeCounter(path, dict), path).toEqual({
        path,
        description: COUNTER_DESCRIPTION_EXPECTATIONS[descriptionKey][_locale],
        ...(expected.format ? { format: expected.format } : {}),
        ...(expected.unit ? { unit: expected.unit } : {}),
      });
    }
  });

  it("matches all eight wildcard fields in bracket and dotted spellings without crossing depth", () => {
    for (const expected of WILDCARD_INSTANCES) {
      const resolved = resolveCounter(expected.path);
      expect(resolved.source, expected.path).toBe("wildcard");
      expect(resolved.entry?.path, expected.path).toBe(expected.pattern);
      expect(resolved.entry?.descriptionKey, expected.path).toBe(expected.descriptionKey);
      expect(describeCounter(expected.path, en).format, expected.path).toBe(expected.format);
    }
    expect(resolveCounter("core.connections_bad_by_class[3].total.extra").source).toBe("fallback");
  });

  it("uses exact, then wildcard, then the ordered family rules", () => {
    expect(resolveCounter("core.connections_total").source).toBe("exact");
    expect(resolveCounter("core.handshake_failures_by_stage[4].total").source).toBe("wildcard");
    expect(resolveCounter("future.handshake_errors_total").family).toBe("errorsTotal");
    expect(resolveCounter("future.payload_bytes_total").family).toBe("total");
  });

  it.each([
    [
      "future.handshake_errors_total",
      "errorsTotal",
      "integer",
      undefined,
      "Накопительное число ошибок с момента запуска прокси.",
      "Cumulative number of errors since the proxy started.",
    ],
    [
      "future.payload_bytes_total",
      "total",
      "integer",
      undefined,
      "Накопительный счётчик с момента запуска прокси.",
      "Cumulative counter since the proxy started.",
    ],
    ["future.payload_bytes", "bytes", undefined, "bytes", "Объём данных.", "Amount of data."],
    [
      "future.latency_ms",
      "milliseconds",
      undefined,
      "milliseconds",
      "Длительность в миллисекундах.",
      "Duration in milliseconds.",
    ],
    [
      "future.window_secs",
      "seconds",
      undefined,
      "seconds",
      "Длительность в секундах.",
      "Duration in seconds.",
    ],
    [
      "future.coverage_pct",
      "percent",
      undefined,
      "percent",
      "Доля в процентах.",
      "Share, in percent.",
    ],
    ["future.active_count", "count", "integer", undefined, "Текущее количество.", "Current count."],
  ] as const)(
    "keeps the %s family output literal in both locales",
    (path, family, format, unit, russian, english) => {
      expect(resolveCounter(path)).toMatchObject({ source: "family", family });
      expect(describeCounter(path, ru)).toEqual({
        path,
        description: russian,
        ...(format ? { format } : {}),
        ...(unit ? { unit } : {}),
      });
      expect(describeCounter(path, en)).toEqual({
        path,
        description: english,
        ...(format ? { format } : {}),
        ...(unit ? { unit } : {}),
      });
    },
  );

  it("uses the neutral fallback without inventing future scalar meaning", () => {
    expect(resolveCounter("future.scalar_signal")).toEqual({
      source: "fallback",
      entry: null,
    });
    expect(describeCounter("future.scalar_signal", ru)).toEqual({
      path: "future.scalar_signal",
      description: "Параметр Telemt; отдельное описание пока отсутствует.",
    });
    expect(describeCounter("future.scalar_signal", en)).toEqual({
      path: "future.scalar_signal",
      description: "A Telemt parameter; no dedicated description yet.",
    });
  });

  it("does not treat prototype-like future paths as exact entries", () => {
    for (const path of ["constructor", "toString", "__proto__"]) {
      expect(resolveCounter(path), path).toEqual({ source: "fallback", entry: null });
    }
  });

  it.each([
    ["ru", ru],
    ["en", en],
  ] as const)("enumerates all 110 displayed zero/all scalar rows in %s", (_locale, dict) => {
    const rows = scalarCounterRows(zeroAll);
    expect(rows.map((row) => row.path)).toEqual(EXPECTED_ZERO_ALL_PATHS);
    expect(rows).toHaveLength(110);
    for (const row of rows) {
      const resolved = resolveCounter(row.path);
      const field = describeCounter(row.path, dict);
      expect(resolved.source, row.path).toBe("family");
      expect(field.description, row.path).not.toBe(dict.details.fields.fallback);
      expect(field.description, row.path).not.toBe("");
    }
  });

  it("keeps only the 118 counter descriptions and seven hub labels in both locales", () => {
    const counterKeys = [...new Set(EXPECTED_ENTRIES.map((entry) => entry.descriptionKey))].sort();
    const hubKeys = [
      "connections.totals.active_users",
      "connections.totals.current_connections",
      "upstreams.summary.configured_total",
      "upstreams.summary.healthy_total",
      "web.lifecycle",
      "web.manager.sessions",
      "web.streams.live",
    ];
    for (const dict of [ru, en]) {
      expect(Object.keys(dict.details.fields.descriptions).sort()).toEqual(counterKeys);
      expect(Object.keys(dict.details.fields.shortLabels).sort()).toEqual(hubKeys);
    }
  });
});
