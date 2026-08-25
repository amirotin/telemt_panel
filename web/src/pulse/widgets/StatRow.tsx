import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import { StatCard } from "../../ui/StatCard";
import { Sparkline } from "../../ui/Sparkline";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { formatBytes } from "../../lib/format";
import { WidgetFrame } from "../WidgetFrame";
import { useHistorySeries } from "../useHistorySeries";
import { computeStatRowValues, latestHistoryValue, sparklineValues } from "./statRow.helpers";

// StatRow — connections/active users/traffic/uptime, each with a sparkline
// from GET /api/history (06-ui.md's default second widget). Traffic is
// explicitly labeled "(15 мин)": the RAM ring only ever holds ~15 minutes of
// raw points (ruling R3), and its own figure is a cumulative total summed
// across users on each stats tick, not a per-window delta — see
// statRow.helpers.ts and task-2-report.md's traffic-metric caveat.
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

  return (
    <WidgetFrame title={ru.pulse.widgets.stat_row} onHide={onHide} stale={stats.stale}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={values.connectionsApprox ? ru.pulse.stat.connectionsApprox : ru.pulse.stat.connections}
          value={values.connections ?? "—"}
          sparkline={<Sparkline values={sparklineValues(connectionsHistory.data)} />}
        />
        <StatCard
          label={values.activeUsersApprox ? ru.pulse.stat.activeUsersApprox : ru.pulse.stat.activeUsers}
          value={values.activeUsers ?? "—"}
          sparkline={<Sparkline values={sparklineValues(usersHistory.data)} />}
        />
        <StatCard
          label={ru.pulse.stat.traffic}
          value={traffic !== null ? formatBytes(traffic) : "—"}
          sparkline={<Sparkline values={sparklineValues(trafficHistory.data)} />}
        />
        <StatCard label={ru.pulse.stat.uptime} value={values.uptimeLabel} />
      </div>
    </WidgetFrame>
  );
}
