import { ru } from "../../i18n/ru";
import { group, type KVGroup } from "./rows";
import type { RuntimeEdgeConnectionsSummary } from "../../realtime/topics";

// connectionsGroups builds the full Соединения page from
// GET /v1/runtime/connections/summary's payload (stats topic's
// connections_summary) — every sub-object as its own group, unlike the
// Активные сессии widget which only shows totals.
export function connectionsGroups(data: RuntimeEdgeConnectionsSummary): KVGroup[] {
  return [
    ...group(ru.diag.groups.totals, data.totals),
    ...group(ru.diag.groups.cache, data.cache),
    ...group(ru.diag.groups.topByConnections, data.top.by_connections),
    ...group(ru.diag.groups.topByThroughput, data.top.by_throughput),
    ...group(ru.diag.groups.telemetry, data.telemetry),
  ];
}
