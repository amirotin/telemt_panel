import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getTrafficSummaryOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { TrafficRange, TrafficSummary, UserTrafficPoint } from "../../lib/api/generated/types.gen";
import { formatBytes } from "../../lib/format";
import { cn } from "../../lib/cn";
import { useStrings } from "../../i18n";
import { Skeleton } from "../../ui/Skeleton";

const ranges: readonly TrafficRange[] = ["24h", "7d", "30d", "month", "1y"];

export function TrafficAnalytics() {
  const s = useStrings();
  const [range, setRange] = useState<TrafficRange>("7d");
  const report = useQuery({
    ...getTrafficSummaryOptions({ query: { range } }),
    refetchInterval: 60_000,
  });
  const month = useQuery({
    ...getTrafficSummaryOptions({ query: { range: "month" } }),
    refetchInterval: 60_000,
  });

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface" data-testid="traffic-analytics">
      <header className="flex flex-col gap-3 border-b border-border px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-[14px] font-bold text-text">{s.hub.userTraffic.title}</h2>
          <p className="mt-0.5 text-[10px] leading-relaxed text-text-muted">{s.hub.userTraffic.note}</p>
        </div>
        <div className="-mx-0.5 flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-bg p-0.5" role="group" aria-label={s.hub.userTraffic.period}>
          {ranges.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={range === value}
              onClick={() => setRange(value)}
              className={cn(
                "min-h-8 shrink-0 rounded-md px-2.5 text-[10px] font-semibold transition-colors",
                range === value ? "bg-surface-2 text-text shadow-sm" : "text-text-muted hover:text-text",
              )}
            >
              {s.hub.userTraffic.ranges[value]}
            </button>
          ))}
        </div>
      </header>

      {report.isPending || month.isPending ? (
        <div className="grid gap-3 p-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]">
          <Skeleton className="h-44 rounded-lg" />
          <Skeleton className="h-44 rounded-lg" />
        </div>
      ) : report.isError || month.isError || !report.data || !month.data ? (
        <p className="m-3.5 rounded-lg bg-warn-soft/30 px-3 py-4 text-[11px] text-warn">{s.hub.userTraffic.unavailable}</p>
      ) : (
        <TrafficReport report={report.data} monthBytes={month.data.total_bytes} />
      )}
    </section>
  );
}

function TrafficReport({ report, monthBytes }: { report: TrafficSummary; monthBytes: number }) {
  const s = useStrings();
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  const todayBytes = report.points.reduce((total, point) => point.ts >= todayStart ? total + point.v : total, 0);
  const historyAvailable = report.state !== "disabled";
  const sourceTone = report.collection.source_state === "collecting" && report.collection.continuity === "normal" ? "text-ok" : "text-warn";
  const sourceText = report.collection.source_state === "collecting"
    ? report.collection.continuity === "partial" ? s.hub.userTraffic.partial : s.hub.userTraffic.collecting
    : report.collection.source_state === "paused" ? s.hub.userTraffic.paused : s.hub.userTraffic.unavailable;

  return (
    <div className="grid gap-3 p-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]">
      <div className="min-w-0">
        <div className="grid grid-cols-3 gap-2">
          <TrafficValue label={s.hub.userTraffic.today} value={historyAvailable ? formatBytes(todayBytes, s) : "—"} />
          <TrafficValue label={s.hub.userTraffic.month} value={formatBytes(monthBytes, s)} />
          <TrafficValue label={s.hub.userTraffic.selected} value={historyAvailable ? formatBytes(report.total_bytes, s) : "—"} />
        </div>
        <TrafficChart points={report.points} from={report.requested_from_epoch_secs} to={report.collection.observed_through_epoch_secs ?? report.requested_from_epoch_secs + 1} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-text-muted">
          <span>{historyAvailable ? comparisonText(report, s) : s.hub.userTraffic.historyDisabled}</span>
          <span className={cn("font-semibold", sourceTone)}>{sourceText}</span>
        </div>
      </div>

      <div className="min-w-0 rounded-lg bg-bg p-3">
        <h3 className="text-[11px] font-semibold text-text">{s.hub.userTraffic.top}</h3>
        {report.top_users.length === 0 ? (
          <p className="mt-3 text-[10px] text-text-muted">{s.hub.userTraffic.empty}</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-1.5">
            {report.top_users.map((user, index) => (
              <li key={user.username}>
                <Link
                  to="/people/$username"
                  params={{ username: user.username }}
                  className="grid min-h-8 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 text-[11px] transition-colors hover:bg-surface-2"
                >
                  <span className="text-[9px] tabular-nums text-text-faint">{index + 1}</span>
                  <strong className="truncate font-medium text-text">{user.username}</strong>
                  <span className="tabular-nums text-text-muted">{formatBytes(user.bytes, s)}</span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function TrafficValue({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0 rounded-lg bg-bg px-2.5 py-2">
      <small className="block truncate text-[9px] text-text-muted">{label}</small>
      <strong className="mt-1 block truncate font-mono text-[15px] font-bold tabular-nums text-text">{value}</strong>
    </span>
  );
}

function TrafficChart({ points, from, to }: { points: UserTrafficPoint[]; from: number; to: number }) {
  const s = useStrings();
  const width = 720;
  const height = 112;
  const max = Math.max(0, ...points.map((point) => point.v));
  const span = Math.max(1, to - from);
  if (points.length === 0 || max === 0) {
    return <div className="mt-3 flex h-28 items-center justify-center rounded-lg bg-bg text-[10px] text-text-muted">{s.hub.userTraffic.empty}</div>;
  }
  return (
    <div className="relative mt-3 overflow-hidden rounded-lg bg-bg">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-28 w-full" role="img" aria-label={s.hub.userTraffic.chart}>
        <defs>
          <linearGradient id="pulse-user-traffic" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgb(var(--accent))" stopOpacity="0.85" />
            <stop offset="1" stopColor="rgb(var(--accent))" stopOpacity="0.18" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => <line key={ratio} x1="0" x2={width} y1={height * ratio} y2={height * ratio} stroke="rgb(var(--border))" strokeWidth="1" />)}
        {points.map((point) => {
          const tierSeconds = point.tier === "1d" ? 86400 : point.tier === "1h" ? 3600 : 900;
          const barWidth = Math.max(1, Math.min(22, tierSeconds / span * width * 0.72));
          const x = Math.max(0, Math.min(width - barWidth, (point.ts - from) / span * width));
          const barHeight = Math.max(1, point.v / max * (height - 8));
          return <rect key={`${point.tier}:${point.ts}`} x={x} y={height - barHeight} width={barWidth} height={barHeight} rx={Math.min(2, barWidth / 2)} fill="url(#pulse-user-traffic)" />;
        })}
      </svg>
      <span className="pointer-events-none absolute right-2 top-1.5 rounded bg-bg/80 px-1 text-[9px] tabular-nums text-text-muted">{formatBytes(max, s)}</span>
      <span className="pointer-events-none absolute bottom-1.5 right-2 text-[9px] text-text-faint">UTC</span>
    </div>
  );
}

function comparisonText(report: TrafficSummary, s: ReturnType<typeof useStrings>): string {
  if (report.previous_total_bytes === undefined) return s.hub.userTraffic.comparisonUnavailable;
  const difference = report.total_bytes - report.previous_total_bytes;
  const sign = difference > 0 ? "+" : difference < 0 ? "−" : "";
  return `${s.hub.userTraffic.previous}: ${sign}${formatBytes(Math.abs(difference), s)}`;
}
