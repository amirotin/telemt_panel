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

// Only the `totals` sub-object is typed — `cache`/`top`/`telemetry` exist on
// the wire but nothing in Task 4 reads them; Task 6's diagnostics
// sub-pages extend this when they need the rest.
export interface RuntimeEdgeConnectionsSummary {
  totals: RuntimeEdgeConnectionTotals;
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
