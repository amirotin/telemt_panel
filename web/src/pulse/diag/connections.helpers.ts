import type {
  RuntimeEdgeConnectionsSummary,
  StatsSummary,
  UsersTopic,
} from "../../realtime/topics";
import type { ConnectionsPagePayload } from "../details-builder/definitions/connections";

// usersTrafficTotal sums every user's cumulative total_octets — the same
// figure internal/hub/hub.go records as the `traffic` history metric, and
// the only lifetime traffic number Telemt exposes. Returns null when the
// users topic hasn't loaded, so an absent payload can never render as "0 B".
export function usersTrafficTotal(users: UsersTopic | null): number | null {
  if (!users) return null;
  return users.users.reduce((sum, u) => sum + u.total_octets, 0);
}

// connectionsPagePayload joins the always-on `GET /v1/stats/summary` half,
// the runtime_edge-gated connections summary and the one derived figure the
// page owns into the payload its definition reads
// (details-builder/definitions/connections.ts).
//
// This is all that is left of the old `connectionsGroups`/`summaryGroup`,
// which flattened the two top-10 rankings into thirty KV rows: composition
// of the page is now the definition's job, and this module only says WHERE
// the data comes from.
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
