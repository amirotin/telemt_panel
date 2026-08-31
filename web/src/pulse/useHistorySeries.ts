import { useQuery } from "@tanstack/react-query";
import { getHistoryOptions } from "../lib/api/generated/@tanstack/react-query.gen";

export type HistoryMetric =
  | "connections"
  | "active_users"
  | "traffic"
  | "refusals"
  | "attempts"
  | "health";

// useHistorySeries wraps GET /api/history for the stat-row widget's
// sparklines (06-ui.md: "спарклайны из /api/history"). It requests the 30m
// range — the whole of what the RAM ring retains (store.MetricCap, and the
// response's own `retention_secs`) — because Сводка shows fifteen minutes
// and compares them against the fifteen before: «−0,3 % за 15 мин» is a
// comparison, and one window cannot make it.
//
// Everything DISPLAYED is still the last fifteen minutes. Callers cut the
// series with statRow.helpers' windowSeries/previousWindowSeries rather than
// plotting whatever came back, so a wider fetch never widens a caption.
//
// The default refetch interval is 30s per the task brief — independent of
// the SSE topics' own poll cadence, since history is a plain REST resource.
// Callers may shorten it for a compact live state that otherwise spends a
// full interval saying that its first two points are still being collected.
export function useHistorySeries(metric: HistoryMetric, refetchInterval = 30_000) {
  return useQuery({
    ...getHistoryOptions({ query: { metric, range: "30m" } }),
    refetchInterval,
  });
}
