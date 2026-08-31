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
import { fill, formatNumber, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useHistorySeries } from "../useHistorySeries";
import type { DiagDomain } from "../types";
import {
  computeStatRowValues,
  connectionQuality,
  deltaSparklineValues,
  historyWindowDelta,
  lastHistoryValue,
  peakHistoryValue,
  qualityCaption,
  qualitySparklineValues,
  round1,
  sparklineValues,
  windowSeries,
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

/** Below this share of successful connections the quality tile turns warn. */
const QUALITY_WARN_PCT = 98;
/** …and so does a decline of more than this many points across the window. */
const QUALITY_DROP_POINTS = -1;

const TONE_TEXT: Record<SparklineTone, string> = {
  accent: "text-accent",
  ok: "text-ok",
  warn: "text-warn",
  error: "text-error",
  muted: "text-text-muted",
};

const CHART_FADE = "linear-gradient(to right, transparent 0%, rgba(0,0,0,0.55) 42%, #000 72%)";

// Tile — the presentation both viewports share (M5 S1 on the desktop grid,
// S2 on the phone's 2×2 per concept §21): the chart is not a thumbnail beside
// the number, it IS the tile's background, filled at the alpha
// styles/contrast.test.ts holds it to so the label, the value and the caption
// all stay AA over it. The whole tile is the link to the domain's Пульс page.
//
// Responsive sizing keeps one semantic tile in the layout at every viewport;
// there is no separate compact copy or enclosing widget frame.
function Tile({ metric }: { metric: Metric }) {
  const { Icon } = metric;
  return (
    <Link
      to="/pulse/diag/$domain"
      params={{ domain: metric.domain }}
      className={cn(
        "relative flex min-h-[96px] min-w-0 flex-col overflow-hidden rounded-xl border border-border p-3 md:min-h-[104px] md:p-3.5",
        "bg-surface transition-colors hover:border-border-strong",
      )}
    >
      {metric.series.length >= 2 && (
        // The chart is faded out under the text: the number and the caption
        // sit at the left, so the mask keeps the curve to the right half
        // where nothing is written over it. The tile still clears AA at the
        // fill's FULL strength (styles/contrast.test.ts) — this only makes a
        // legible tile more legible.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[64%]"
          style={{
            maskImage: CHART_FADE,
            WebkitMaskImage: CHART_FADE,
          }}
        >
          <Sparkline values={metric.series} tone={metric.tone} area decorative />
        </span>
      )}
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-[72%] bg-gradient-to-r from-surface via-surface/95 to-transparent" />
      <span className="relative flex items-start gap-1.5 md:items-center">
        <Icon className={cn("mt-[2px] h-3.5 w-3.5 shrink-0 md:mt-0", TONE_TEXT[metric.tone])} />
        {/* «АКТИВНЫЕ ПОЛЬЗОВАТЕЛИ» wants 108px of the 102 a 144px phone tile
            leaves beside the icon, and a KPI labelled «АКТИВНЫЕ ПОЛЬЗОВАТЕЛ…»
            is a KPI you have to guess at. So the phone label drops to 10.5px
            without letter-spacing and wraps into two RESERVED lines, keeping
            all four numbers on one baseline; break-words is the net for any
            label longer still. min-w-0 is what lets it wrap at all — a flex
            item never shrinks below its content width without it, and
            `overflow-hidden` would cut the word instead of breaking it. */}
        <span
          className={cn(
            "line-clamp-2 min-h-[26px] min-w-0 flex-1 break-words text-[10.5px] font-semibold uppercase leading-[1.25] text-text-muted",
            "md:min-h-0 md:truncate md:text-micro md:tracking-[0.06em]",
          )}
        >
          {metric.label}
        </span>
      </span>
      <span
        className={cn(
          "relative mt-auto block font-mono font-bold leading-none tabular-nums text-text",
          "pt-2 text-[22px] md:pt-3 md:text-[30px]",
        )}
      >
        {metric.value}
      </span>
      <span className="relative -ml-1 mt-1.5 block h-[17px] max-w-full self-start truncate rounded bg-surface/90 px-1 text-micro leading-[17px] text-text-muted">
        {metric.caption}
      </span>
    </Link>
  );
}

// StatRow — «Показатели»: connections · active users · traffic · connection
// quality, each with its own /api/history series (06-ui.md's default second
// widget; the fourth KPI per the dashboard concept §5 — «нормально ли
// устанавливаются соединения», with «Проблемы» below explaining why not).
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
// version and the route mode, and a dashboard does not need the same figure
// twice.
export function StatRow() {
  const s = useStrings();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const connectionsHistory = useHistorySeries("connections");
  const usersHistory = useHistorySeries("active_users");
  const trafficHistory = useHistorySeries("traffic");
  const refusalsHistory = useHistorySeries("refusals");
  const attemptsHistory = useHistorySeries("attempts");

  if (!stats.data) {
    return (
      <div className="grid grid-cols-2 gap-2.5 md:gap-3 lg:grid-cols-4 lg:gap-5">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  const values = computeStatRowValues(stats.data);
  // /api/history now returns thirty minutes (useHistorySeries) so the
  // quality tile can compare two windows. Everything shown is still the last
  // fifteen, so every other reading is taken from the cut series — the
  // fetch got wider, the captions did not.
  const connectionsWindow = windowSeries(connectionsHistory.data);
  const usersWindow = windowSeries(usersHistory.data);
  const trafficWindow = windowSeries(trafficHistory.data);
  const traffic = historyWindowDelta(trafficWindow);
  const trafficTotal = lastHistoryValue(trafficWindow);
  const quality = connectionQuality(attemptsHistory.data, refusalsHistory.data);
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
      caption: peakCaption(peakHistoryValue(connectionsWindow)),
      series: sparklineValues(connectionsWindow),
      domain: "connections",
    },
    {
      key: "active_users",
      Icon: IconPeople,
      tone: "ok",
      label: values.activeUsersApprox ? s.pulse.stat.activeUsersApprox : s.pulse.stat.activeUsers,
      value: values.activeUsers ?? "—",
      caption: peakCaption(peakHistoryValue(usersWindow)),
      series: sparklineValues(usersWindow),
      domain: "connections",
    },
    {
      key: "traffic",
      Icon: IconTraffic,
      tone: "accent",
      label: s.pulse.stat.traffic,
      value: traffic !== null ? formatBytes(traffic, s) : "—",
      caption: totalCaption(trafficTotal === null ? null : formatBytes(trafficTotal, s)),
      series: deltaSparklineValues(trafficWindow),
      domain: "connections",
    },
    {
      key: "quality",
      Icon: IconShieldAlert,
      // Warn when connections are failing at a rate worth looking at, or
      // when the rate is getting worse inside the window — not for a burst
      // that has already stopped, which the reader would learn to ignore.
      tone:
        quality.percent !== null &&
        (quality.percent < QUALITY_WARN_PCT ||
          (quality.changePoints !== null && quality.changePoints < QUALITY_DROP_POINTS))
          ? "warn"
          : "ok",
      label: s.pulse.stat.quality,
      value: quality.percent === null ? "—" : `${formatNumber(s, round1(quality.percent))} %`,
      // The concept's own preferred caption (§5): how the figure MOVED,
      // this window against the previous one. Until a previous window exists
      // — the first quarter-hour after a panel start — it falls back to
      // naming the refusals rather than claiming a comparison it cannot make.
      caption: qualityCaption(quality, s),
      series: qualitySparklineValues(windowSeries(attemptsHistory.data), windowSeries(refusalsHistory.data)),
      domain: "counters",
    },
  ];

  return (
    <section
      aria-label={s.pulse.widgets.stat_row}
      className="grid grid-cols-2 gap-2.5 md:gap-3 lg:grid-cols-4 lg:gap-5"
      data-testid="kpi-grid"
    >
      {metrics.map((m) => (
        <Tile key={m.key} metric={m} />
      ))}
    </section>
  );
}
