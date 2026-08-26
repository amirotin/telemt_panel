import type { Dict } from "../../i18n";
import { formatBytes } from "../../lib/format";
import { group, type KVGroup } from "./rows";
import type { RuntimeEdgeConnectionsSummary, StatsSummary, UsersTopic } from "../../realtime/topics";

// usersTrafficTotal sums every user's cumulative total_octets — the same
// figure internal/hub/hub.go records as the `traffic` history metric, and
// the only lifetime traffic number Telemt exposes. Returns null when the
// users topic hasn't loaded, so an absent payload can never render as "0 B".
export function usersTrafficTotal(users: UsersTopic | null): number | null {
  if (!users) return null;
  return users.users.reduce((sum, u) => sum + u.total_octets, 0);
}

// summaryGroup surfaces every scalar/array on GET /v1/stats/summary
// (always-on, never Gated[T] — unlike connections_summary below) at the top
// of the Соединения page, so the page stays useful even when runtime_edge
// is off and connections_summary itself is gated. Includes
// connections_bad_total/handshake_timeouts_total/connections_bad_by_class,
// which the Problems widget only surfaces when they are currently growing.
//
// The lifetime traffic total is appended here as the one honest home for
// that figure: Пульс's "Трафик (15 мин)" row is a per-window delta by
// design (statRow.helpers.ts's historyWindowDelta), so the cumulative number
// it used to show wrongly needs somewhere real to live.
export function summaryGroup(
  summary: StatsSummary | null,
  trafficTotal: number | null,
  s: Dict,
): KVGroup[] {
  const groups = group(s.diag.groups.summary, summary, s);
  if (trafficTotal === null) return groups;
  const row = {
    key: "users_traffic_total",
    label: s.diag.trafficTotal,
    value: formatBytes(trafficTotal, s),
  };
  if (groups.length === 0) return [{ title: s.diag.groups.summary, rows: [row] }];
  return [{ title: groups[0].title, rows: [...groups[0].rows, row] }];
}

// connectionsGroups builds the full Соединения page from
// GET /v1/runtime/connections/summary's payload (stats topic's
// connections_summary) — every sub-object as its own group, unlike the
// Активные сессии widget which only shows totals.
export function connectionsGroups(data: RuntimeEdgeConnectionsSummary, s: Dict): KVGroup[] {
  return [
    ...group(s.diag.groups.totals, data.totals, s),
    ...group(s.diag.groups.cache, data.cache, s),
    ...group(s.diag.groups.topByConnections, data.top.by_connections, s),
    ...group(s.diag.groups.topByThroughput, data.top.by_throughput, s),
    ...group(s.diag.groups.telemetry, data.telemetry, s),
  ];
}
