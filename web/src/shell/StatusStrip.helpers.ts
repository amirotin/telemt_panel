import { countLabel, type Dict } from "../i18n";
import type { State } from "../ui/StatePill";
import type { StatsSnapshot } from "../realtime/topics";
import type { HistorySeries } from "../lib/api/generated/types.gen";
import { formatBytes } from "../lib/format";
import { latestHistoryValue } from "../pulse/widgets/statRow.helpers";

// Pure helpers factored out of StatusStrip.tsx per the project's
// colocated-helpers-with-tests convention (06-ui.md / web/README.md).

export function healthPillState(status: string | undefined): State {
  if (!status) return "muted";
  if (status === "ok" || status === "healthy") return "ok";
  if (status === "starting") return "warn";
  return "error";
}

export function healthLabel(status: string | undefined, s: Dict): string {
  if (!status) return s.health.unknown;
  if (status === "ok" || status === "healthy") return s.health.ok;
  if (status === "starting") return s.health.starting;
  return s.health.degraded;
}

// connectionsLabel picks the best connections figure actually available in
// M3 without runtime_edge (task-2-report.md's own "coarse proxy" caveat):
// the live current_connections total when runtime_edge's connections
// summary is enabled, otherwise the cumulative (not concurrent)
// connections_total from the always-on summary. "—" when nothing is
// available yet. Returns the whole "713 conns" phrase — the count and its
// unit have to agree on the plural form, so they are built together.
export function connectionsLabel(data: StatsSnapshot | null, s: Dict): string {
  if (!data) return "—";
  const live = data.connections_summary?.data?.totals.current_connections;
  if (typeof live === "number") return countLabel(s, live, s.shell.connectionsUnit);
  if (data.summary) return countLabel(s, data.summary.connections_total, s.shell.connectionsUnit);
  return "—";
}

// trafficLabel reuses StatRow's own 15-min /api/history figure (same
// useHistorySeries("traffic") query + latestHistoryValue helper it uses)
// rather than the permanent «н/д» this readout showed before that history
// endpoint existed — see StatusStrip.tsx's own useHistorySeries call. Falls
// back to trafficUnavailable only when the 15-min ring genuinely has no
// points yet (covers both "still loading" and "no traffic recorded").
export function trafficLabel(series: HistorySeries | undefined, s: Dict): string {
  const traffic = latestHistoryValue(series);
  return traffic === null ? s.shell.trafficUnavailable : formatBytes(traffic, s);
}
