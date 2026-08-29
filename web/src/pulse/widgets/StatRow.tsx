import type { ComponentType, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import { Sparkline, type SparklineTone } from "../../ui/Sparkline";
import { Skeleton } from "../../ui/Skeleton";
import {
  IconActivity,
  IconPeople,
  IconShieldAlert,
  IconTraffic,
  type IconProps,
} from "../../ui/icons";
import { fill, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { WidgetFrame } from "../WidgetFrame";
import { useHistorySeries } from "../useHistorySeries";
import type { DiagDomain } from "../types";
import {
  computeStatRowValues,
  deltaSparklineValues,
  historyWindowDelta,
  lastHistoryValue,
  peakHistoryValue,
  refusalsLifetimeTotal,
  refusalsRising,
  sparklineValues,
} from "./statRow.helpers";

// One metric, described once and rendered twice: as a desktop tile and as a
// phone row. Two renderings of the same object cannot disagree about which
// number belongs to which label.
interface Metric {
  key: string;
  Icon: ComponentType<IconProps>;
  tone: SparklineTone;
  label: string;
  value: ReactNode;
  /** Secondary line — omitted when there is nothing real to say. */
  caption?: string;
  series: number[];
  /** The Пульс page this metric's full story lives on. */
  domain: DiagDomain;
}

const TONE_TEXT: Record<SparklineTone, string> = {
  accent: "text-accent",
  ok: "text-ok",
  warn: "text-warn",
  error: "text-error",
  muted: "text-text-muted",
};

// Written out rather than interpolated: Tailwind scans source text for
// class names, so `bg-${tone}/12` would compile to nothing at all.
const TONE_PLATE: Record<SparklineTone, string> = {
  accent: "bg-accent/12",
  ok: "bg-ok/12",
  warn: "bg-warn/12",
  error: "bg-error/12",
  muted: "bg-surface-2",
};

// Tile — the desktop presentation (M5 S1): the chart is not a thumbnail
// beside the number, it IS the tile's background, filled at the alpha
// styles/contrast.test.ts holds it to so the label, the 30px value and the
// caption all stay AA over it. The whole tile is the link to the domain's
// Пульс page.
function Tile({ metric }: { metric: Metric }) {
  const { Icon } = metric;
  return (
    <Link
      to="/pulse/diag/$domain"
      params={{ domain: metric.domain }}
      className={cn(
        "relative hidden min-h-[124px] min-w-0 flex-col overflow-hidden rounded-xl border border-border",
        "bg-surface p-3.5 transition-colors hover:border-border-strong lg:col-span-3 lg:flex",
      )}
    >
      {metric.series.length >= 2 && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%]">
          <Sparkline values={metric.series} tone={metric.tone} area decorative />
        </span>
      )}
      <span className="relative flex items-center gap-1.5">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", TONE_TEXT[metric.tone])} />
        <span className="truncate text-micro font-semibold uppercase tracking-[0.06em] text-text-muted">
          {metric.label}
        </span>
      </span>
      <span className="relative mt-auto block pt-3 font-mono text-[30px] font-bold leading-none tabular-nums text-text">
        {metric.value}
      </span>
      <span className="relative mt-1.5 block h-[15px] truncate text-micro text-text-muted">
        {metric.caption}
      </span>
    </Link>
  );
}

// MetricRow — the phone presentation, unchanged from M3: a round tinted
// plate, then a column whose own hairline (not the list's) separates it from
// the next row, so the rule starts after the icon exactly as in the design.
function MetricRow({ metric }: { metric: Metric }) {
  const { Icon } = metric;
  const hasSpark = metric.series.length >= 2;
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-[17px]",
          TONE_PLATE[metric.tone],
          TONE_TEXT[metric.tone],
        )}
      >
        <Icon />
      </span>
      <div className="min-w-0 flex-1 border-b border-border pb-2.5 pt-2 last:border-b-0">
        <div className="flex items-baseline gap-3">
          <span className="min-w-0 truncate text-row font-semibold text-text">{metric.label}</span>
          <span className="ml-auto shrink-0 font-mono text-sm font-bold tabular-nums text-text">
            {metric.value}
          </span>
        </div>
        {(metric.caption || hasSpark) && (
          <div className="mt-1 flex items-center gap-2.5">
            <span className="min-w-0 flex-1 truncate text-micro text-text-muted">
              {metric.caption}
            </span>
            {hasSpark && (
              <Sparkline
                values={metric.series}
                tone={metric.tone}
                width={76}
                height={16}
                className="shrink-0"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// StatRow — «Показатели»: connections · active users · traffic · refusals,
// each with its own /api/history series (06-ui.md's default second widget).
//
// The two window metrics are labelled "(15 мин)" and show exactly that: the
// recorded traffic series is a cumulative lifetime total summed across users
// on each stats tick and the refusals series is the hub's own accumulator
// (internal/hub/refusals.go), so both render newest − oldest over the window
// and plot per-step deltas — see statRow.helpers.ts. Their lifetime figures
// go in the caption rather than the value, which is where the "256 ГБ за 15
// минут" bug used to live.
//
// The uptime metric is gone: the status banner carries it now, beside the
// version and the last config reload, and a dashboard does not need the same
// figure twice.
export function StatRow({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const connectionsHistory = useHistorySeries("connections");
  const usersHistory = useHistorySeries("active_users");
  const trafficHistory = useHistorySeries("traffic");
  const refusalsHistory = useHistorySeries("refusals");

  if (!stats.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.stat_row} onHide={onHide}>
        <Skeleton className="h-20 w-full" />
      </WidgetFrame>
    );
  }

  const values = computeStatRowValues(stats.data);
  const traffic = historyWindowDelta(trafficHistory.data);
  const refusals = historyWindowDelta(refusalsHistory.data);
  const trafficTotal = lastHistoryValue(trafficHistory.data);
  const refusalsTotal = refusalsLifetimeTotal(stats.data);
  // Peak is only meaningful for the two instantaneous gauges: on a
  // cumulative counter the maximum is just its last point.
  const peakCaption = (peak: number | null) =>
    peak === null ? undefined : `${s.pulse.stat.peak15m} — ${peak}`;
  const totalCaption = (total: string | null) =>
    total === null ? undefined : fill(s.pulse.stat.totalAllTime, { value: total });

  const metrics: Metric[] = [
    {
      key: "connections",
      Icon: IconActivity,
      tone: "accent",
      label: values.connectionsApprox ? s.pulse.stat.connectionsApprox : s.pulse.stat.connections,
      value: values.connections ?? "—",
      caption: peakCaption(peakHistoryValue(connectionsHistory.data)),
      series: sparklineValues(connectionsHistory.data),
      domain: "connections",
    },
    {
      key: "active_users",
      Icon: IconPeople,
      tone: "ok",
      label: values.activeUsersApprox ? s.pulse.stat.activeUsersApprox : s.pulse.stat.activeUsers,
      value: values.activeUsers ?? "—",
      caption: peakCaption(peakHistoryValue(usersHistory.data)),
      series: sparklineValues(usersHistory.data),
      domain: "connections",
    },
    {
      key: "traffic",
      Icon: IconTraffic,
      tone: "accent",
      label: s.pulse.stat.traffic,
      value: traffic !== null ? formatBytes(traffic, s) : "—",
      caption: totalCaption(trafficTotal === null ? null : formatBytes(trafficTotal, s)),
      series: deltaSparklineValues(trafficHistory.data),
      domain: "connections",
    },
    {
      key: "refusals",
      Icon: IconShieldAlert,
      // Warn only while it is still happening: a window that counted a
      // burst which has since stopped is history, not an alarm.
      tone: refusals !== null && refusals > 0 && refusalsRising(refusalsHistory.data) ? "warn" : "ok",
      label: s.pulse.stat.refusals,
      value: refusals ?? "—",
      caption: totalCaption(refusalsTotal === null ? null : String(refusalsTotal)),
      series: deltaSparklineValues(refusalsHistory.data),
      domain: "counters",
    },
  ];

  return (
    <>
      {/* The phone keeps the titled card with four rows; the desktop tiles
          are this widget's own grid cells (registry size: "tiles"), which
          is why they are siblings of the card and not nested in it. */}
      <div className="lg:hidden">
        <WidgetFrame title={s.pulse.widgets.stat_row} onHide={onHide} stale={stats.stale}>
          <div className="flex flex-col">
            {metrics.map((m) => (
              <MetricRow key={m.key} metric={m} />
            ))}
          </div>
        </WidgetFrame>
      </div>
      {metrics.map((m) => (
        <Tile key={m.key} metric={m} />
      ))}
    </>
  );
}
