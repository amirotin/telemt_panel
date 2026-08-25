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
