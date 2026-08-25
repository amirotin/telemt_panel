import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { StatePill } from "../ui/StatePill";
import { Skeleton } from "../ui/Skeleton";
import { useSnapshot, useConnectionState } from "../realtime";
import type { StatsSnapshot } from "../realtime/topics";
import { connectionsLabel, healthLabel, healthPillState } from "./StatusStrip.helpers";

// StatusStrip — the always-visible health/connections/traffic strip
// (design-brief.md §Навигация: "глобальный статус-стрип"), driven entirely
// by the SSE store's `stats` topic. Connections/traffic use the best figure
// actually available in M3 without runtime_edge (see StatusStrip.helpers.ts);
// Task 6's dashboard stat row computes a proper figure from /api/history
// once that widget exists.
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
