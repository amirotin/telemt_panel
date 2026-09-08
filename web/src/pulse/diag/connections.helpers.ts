import type {
  RuntimeEdgeConnectionsSummary,
  StatsSummary,
  UsersTopic,
} from "../../realtime/topics";

export interface ConnectionsPagePayload {
  summary?: StatsSummary;
  users_traffic_total?: number;
  cache?: RuntimeEdgeConnectionsSummary["cache"];
  totals?: RuntimeEdgeConnectionsSummary["totals"];
  top?: RuntimeEdgeConnectionsSummary["top"];
  telemetry?: RuntimeEdgeConnectionsSummary["telemetry"];
}

// usersTrafficTotal sums panel-owned observed totals. Raw Telemt total_octets
// resets with the service and must never be presented as durable lifetime
// traffic. Returns null until at least one collector summary is available.
export function usersTrafficTotal(users: UsersTopic | null): number | null {
  if (!users) return null;
  const observed = users.users.flatMap((user) => user.traffic ? [user.traffic.observed_total_bytes] : []);
  return observed.length === 0 ? null : observed.reduce((sum, bytes) => sum + bytes, 0);
}

// connectionsPagePayload joins the always-on `GET /v1/stats/summary` half,
// the runtime_edge-gated connections summary and the one derived figure the
// page owns into the payload its bespoke view reads.
//
// This is all that is left of the old `connectionsGroups`/`summaryGroup`,
// which flattened the two top-10 rankings into thirty KV rows: composition
// of the page is now the view's job, and this module only says WHERE the data comes from.
//
// The four blocks of connections_summary are spread FLAT (`cache`,
// `totals`, `top`, `telemetry`) because the field catalog keys those paths
// exactly as the wire spells them under the gate.
export function connectionsPagePayload(
  summary: StatsSummary | null | undefined,
  connections: RuntimeEdgeConnectionsSummary | null | undefined,
  trafficTotal: number | null,
): ConnectionsPagePayload | null {
  const payload: ConnectionsPagePayload = {
    ...(summary ? { summary } : {}),
    ...(trafficTotal !== null ? { users_traffic_total: trafficTotal } : {}),
    ...(connections
      ? {
          cache: connections.cache,
          totals: connections.totals,
          top: connections.top,
          telemetry: connections.telemetry,
        }
      : {}),
  };
  return Object.keys(payload).length === 0 ? null : payload;
}
