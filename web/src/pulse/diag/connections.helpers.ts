import type { Dict } from "../../i18n";
import { group, type KVGroup } from "./rows";
import type { RuntimeEdgeConnectionsSummary, StatsSummary } from "../../realtime/topics";

// summaryGroup surfaces every scalar/array on GET /v1/stats/summary
// (always-on, never Gated[T] — unlike connections_summary below) at the top
// of the Соединения page, so the page stays useful even when runtime_edge
// is off and connections_summary itself is gated. Includes
// connections_bad_total/handshake_timeouts_total/connections_bad_by_class,
// which the Problems widget only surfaces as a ranked list, not in full.
export function summaryGroup(summary: StatsSummary | null, s: Dict): KVGroup[] {
  return group(s.diag.groups.summary, summary, s);
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
