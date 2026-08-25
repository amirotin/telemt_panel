import { ru } from "../i18n/ru";
import type { State } from "../ui/StatePill";
import type { StatsSnapshot } from "../realtime/topics";

// Pure helpers factored out of StatusStrip.tsx per the project's
// colocated-helpers-with-tests convention (06-ui.md / web/README.md).

export function healthPillState(status: string | undefined): State {
  if (!status) return "muted";
  if (status === "ok" || status === "healthy") return "ok";
  if (status === "starting") return "warn";
  return "error";
}

export function healthLabel(status: string | undefined): string {
  if (!status) return ru.health.unknown;
  if (status === "ok" || status === "healthy") return ru.health.ok;
  if (status === "starting") return ru.health.starting;
  return ru.health.degraded;
}

// connectionsLabel picks the best connections figure actually available in
// M3 without runtime_edge (task-2-report.md's own "coarse proxy" caveat):
// the live current_connections total when runtime_edge's connections
// summary is enabled, otherwise the cumulative (not concurrent)
// connections_total from the always-on summary. "—" when nothing is
// available yet.
export function connectionsLabel(data: StatsSnapshot | null): string {
  if (!data) return "—";
  const live = data.connections_summary?.data?.totals.current_connections;
  if (typeof live === "number") return String(live);
  if (data.summary) return String(data.summary.connections_total);
  return "—";
}
