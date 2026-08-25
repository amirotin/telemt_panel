import { useQuery } from "@tanstack/react-query";
import { getHistoryOptions } from "../lib/api/generated/@tanstack/react-query.gen";

export type HistoryMetric = "connections" | "active_users" | "traffic" | "health";

// useHistorySeries wraps GET /api/history for the stat-row widget's
// sparklines (06-ui.md: "спарклайны из /api/history"). Always requests the
// 15m range — ruling R3: the RAM ring only ever retains ~15 minutes of raw
// points no matter which range is requested, so asking for a longer one
// would just be a slower way to get the same points back. refetchInterval
// 30s per the task brief — independent of the SSE topics' own poll cadence,
// since history is a plain REST resource, not a hub topic.
export function useHistorySeries(metric: HistoryMetric) {
  return useQuery({
    ...getHistoryOptions({ query: { metric, range: "15m" } }),
    refetchInterval: 30_000,
  });
}
