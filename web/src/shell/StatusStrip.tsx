import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { StatePill } from "../ui/StatePill";
import { Skeleton } from "../ui/Skeleton";
import { useSnapshot, useConnectionState } from "../realtime";
import type { StatsSnapshot } from "../realtime/topics";
import { connectionsLabel, healthLabel, healthPillState } from "./StatusStrip.helpers";

const DOT_CLASSES = {
  ok: "bg-ok",
  warn: "bg-warn",
  error: "bg-error",
  muted: "bg-muted",
} as const;

export interface StatusStripProps {
  /**
   * "strip" — the mobile bar under the header (dot + label, counters
   * right-aligned); "card" — the boxed summary pinned to the bottom of the
   * `lg:` sidebar (prototype: «● Работает / 713 соед · 18,3 ГБ»).
   */
  variant?: "strip" | "card";
  className?: string;
}

// StatusStrip — the always-visible health/connections/traffic readout
// (design-brief.md §Навигация: "глобальный статус-стрип"), driven entirely
// by the SSE store's `stats` topic. Connections/traffic use the best figure
// actually available in M3 without runtime_edge (see StatusStrip.helpers.ts);
// traffic stays an honest «н/д» until Task 6's history-backed figure exists
// rather than showing a number that would mean something else.
export function StatusStrip({ variant = "strip", className }: StatusStripProps) {
  const s = useStrings();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const connection = useConnectionState();
  const isStale = stats.stale || connection.stale;

  const state = healthPillState(stats.data?.health?.status);
  const counters = `${connectionsLabel(stats.data, s)} · ${s.shell.trafficUnavailable}`;

  const flags = (
    <>
      {isStale && <StatePill state="warn">{s.shell.stale}</StatePill>}
      {connection.status === "reconnecting" && (
        <StatePill state="warn">{s.shell.reconnecting}</StatePill>
      )}
      {connection.status === "polling" && <StatePill state="muted">{s.shell.polling}</StatePill>}
    </>
  );

  if (variant === "card") {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <div className="rounded-lg border border-border bg-bg px-3 py-2.5">
          {stats.data ? (
            <div className="flex items-center gap-2">
              <span
                className={cn("h-[7px] w-[7px] shrink-0 rounded-full", DOT_CLASSES[state])}
                aria-hidden="true"
              />
              <span className="text-meta font-semibold text-text">
                {healthLabel(stats.data.health?.status, s)}
              </span>
            </div>
          ) : (
            <Skeleton className="h-4 w-24" />
          )}
          <div className="mt-1 font-mono text-micro tabular-nums text-text-muted">{counters}</div>
        </div>
        {(isStale || connection.status !== "open") && (
          <div className="flex flex-wrap gap-1.5">{flags}</div>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {stats.data ? (
        <>
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", DOT_CLASSES[state])}
            aria-hidden="true"
          />
          <span className="text-meta font-semibold text-text">
            {healthLabel(stats.data.health?.status, s)}
          </span>
        </>
      ) : (
        <Skeleton className="h-4 w-20" />
      )}
      <span className="ml-auto flex items-center gap-2">
        {flags}
        <span className="font-mono text-micro tabular-nums text-text-muted">{counters}</span>
      </span>
    </div>
  );
}
