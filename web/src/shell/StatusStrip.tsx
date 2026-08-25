import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { StatePill, type State } from "../ui/StatePill";
import { Skeleton } from "../ui/Skeleton";
import { useSnapshot, useConnectionState } from "../realtime";
import type { StatsSnapshot } from "../realtime/topics";

// StatusStrip — the always-visible health/connections/traffic strip
// (design-brief.md §Навигация: "глобальный статус-стрип"), driven entirely
// by the SSE store's `stats` topic. Connections/traffic use the best figure
// actually available in M3 without runtime_edge (documented inline below —
// task-2-report.md's own "coarse proxy" caveat); Task 6's dashboard stat
// row computes a proper figure from /api/history once that widget exists.
export function StatusStrip({ className }: { className?: string }) {
  const stats = useSnapshot<StatsSnapshot>("stats");
  const connection = useConnectionState();
  const isStale = stats.stale || connection.stale;

  return (
    <div className={cn("flex flex-wrap items-center gap-3 text-xs", className)}>
      {stats.data ? (
        <StatePill state={healthPillState(stats.data.health?.status)}>
          {healthLabel(stats.data.health?.status)}
        </StatePill>
      ) : (
        <Skeleton className="h-6 w-20" />
      )}
      <span className="text-text-muted">
        {ru.shell.connections}:{" "}
        <span className="tabular-nums text-text">{connectionsLabel(stats.data)}</span>
      </span>
      <span className="text-text-muted">
        {ru.shell.traffic}: <span className="tabular-nums text-text">{ru.shell.trafficUnavailable}</span>
      </span>
      {isStale && <StatePill state="warn">{ru.shell.stale}</StatePill>}
      {connection.status === "reconnecting" && (
        <StatePill state="warn">{ru.shell.reconnecting}</StatePill>
      )}
      {connection.status === "polling" && <StatePill state="muted">{ru.shell.polling}</StatePill>}
    </div>
  );
}

function healthPillState(status: string | undefined): State {
  if (!status) return "muted";
  if (status === "ok" || status === "healthy") return "ok";
  if (status === "starting") return "warn";
  return "error";
}

function healthLabel(status: string | undefined): string {
  if (!status) return ru.health.unknown;
  if (status === "ok" || status === "healthy") return ru.health.ok;
  if (status === "starting") return ru.health.starting;
  return ru.health.degraded;
}

function connectionsLabel(data: StatsSnapshot | null): string {
  if (!data) return "—";
  const live = data.connections_summary?.data?.totals.current_connections;
  if (typeof live === "number") return String(live);
  if (data.summary) return String(data.summary.connections_total);
  return "—";
}
