import type { ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import { Sparkline } from "../../ui/Sparkline";
import { Skeleton } from "../../ui/Skeleton";
import { IconActivity, IconClock, IconPeople, IconTraffic } from "../../ui/icons";
import { ru } from "../../i18n/ru";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { WidgetFrame } from "../WidgetFrame";
import { useHistorySeries } from "../useHistorySeries";
import {
  computeStatRowValues,
  latestHistoryValue,
  peakHistoryValue,
  sparklineValues,
} from "./statRow.helpers";

type Tone = "accent" | "ok" | "muted";

interface MetricRowProps {
  icon: ReactNode;
  /** Tint for the round icon plate. */
  tone: Tone;
  label: string;
  value: ReactNode;
  /** Secondary line under the label — omitted when there is nothing real to say. */
  sub?: string;
  series?: number[];
}

const TONE_PLATE: Record<Tone, string> = {
  accent: "bg-accent/12 text-accent",
  ok: "bg-ok/12 text-ok",
  muted: "bg-surface-2 text-text-muted",
};

// MetricRow — the prototype's Пульс row: a round tinted plate, then a
// column whose own hairline (not the list's) separates it from the next
// row, so the rule starts after the icon exactly as in the design. The
// second line carries the muted sub-text on the left and the sparkline on
// the right, and is skipped entirely when a metric has neither.
function MetricRow({ icon, tone, label, value, sub, series }: MetricRowProps) {
  const hasSpark = series !== undefined && series.length >= 2;
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-[17px]",
          TONE_PLATE[tone],
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 border-b border-border pb-2.5 pt-2 last:border-b-0">
        <div className="flex items-baseline gap-3">
          <span className="min-w-0 truncate text-row font-semibold text-text">{label}</span>
          <span className="ml-auto shrink-0 font-mono text-sm font-bold tabular-nums text-text">
            {value}
          </span>
        </div>
        {(sub || hasSpark) && (
          <div className="mt-1 flex items-center gap-2.5">
            <span className="min-w-0 flex-1 truncate text-micro text-text-muted">{sub}</span>
            {hasSpark && <Sparkline values={series} width={76} height={16} className="shrink-0" />}
          </div>
        )}
      </div>
    </div>
  );
}

// StatRow — connections/active users/traffic/uptime, each with a sparkline
// from GET /api/history (06-ui.md's default second widget). Traffic is
// explicitly labeled "(15 мин)": the RAM ring only ever holds ~15 minutes of
// raw points (ruling R3), and its own figure is a cumulative total summed
// across users on each stats tick, not a per-window delta — see
// statRow.helpers.ts and task-2-report.md's traffic-metric caveat.
//
// Rendered as the prototype's metric *rows* at every width. The prototype
// also has a 4-up tile grid for wide screens; rows are used for both so the
// dashboard reads the same on a phone and a desktop, and so a long Russian
// label ("Активные пользователи (оценка)") has somewhere to go.
export function StatRow({ onHide }: { onHide?: () => void }) {
  const stats = useSnapshot<StatsSnapshot>("stats");
  const connectionsHistory = useHistorySeries("connections");
  const usersHistory = useHistorySeries("active_users");
  const trafficHistory = useHistorySeries("traffic");

  if (!stats.data) {
    return (
      <WidgetFrame title={ru.pulse.widgets.stat_row} onHide={onHide}>
        <Skeleton className="h-20 w-full" />
      </WidgetFrame>
    );
  }

  const values = computeStatRowValues(stats.data);
  const traffic = latestHistoryValue(trafficHistory.data);
  // Peak is only meaningful for the two instantaneous gauges: the traffic
  // series is a cumulative counter, whose maximum is just its last point.
  const connectionsPeak = peakHistoryValue(connectionsHistory.data);
  const usersPeak = peakHistoryValue(usersHistory.data);
  const peakLabel = (peak: number | null) =>
    peak === null ? undefined : `${ru.pulse.stat.peak15m} — ${peak}`;

  return (
    <WidgetFrame title={ru.pulse.widgets.stat_row} onHide={onHide} stale={stats.stale}>
      <div className="flex flex-col">
        <MetricRow
          icon={<IconActivity />}
          tone="accent"
          label={values.connectionsApprox ? ru.pulse.stat.connectionsApprox : ru.pulse.stat.connections}
          value={values.connections ?? "—"}
          sub={peakLabel(connectionsPeak)}
          series={sparklineValues(connectionsHistory.data)}
        />
        <MetricRow
          icon={<IconPeople />}
          tone="ok"
          label={values.activeUsersApprox ? ru.pulse.stat.activeUsersApprox : ru.pulse.stat.activeUsers}
          value={values.activeUsers ?? "—"}
          sub={peakLabel(usersPeak)}
          series={sparklineValues(usersHistory.data)}
        />
        <MetricRow
          icon={<IconTraffic />}
          tone="accent"
          label={ru.pulse.stat.traffic}
          value={traffic !== null ? formatBytes(traffic) : "—"}
          series={sparklineValues(trafficHistory.data)}
        />
        <MetricRow
          icon={<IconClock />}
          tone="muted"
          label={ru.pulse.stat.uptime}
          value={values.uptimeLabel}
        />
      </div>
    </WidgetFrame>
  );
}
