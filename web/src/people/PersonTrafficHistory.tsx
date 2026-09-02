import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getUserTrafficHistoryOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import { formatBytes } from "../lib/format";
import { useStrings } from "../i18n";
import { cn } from "../lib/cn";
import { Skeleton } from "../ui/Skeleton";
import { trafficBarHeights, trafficHistorySummary } from "./trafficHistory.helpers";

type TrafficRange = "24h" | "7d" | "30d";

export function PersonTrafficHistory({ username }: { username: string }) {
  const s = useStrings();
  const [range, setRange] = useState<TrafficRange>("24h");
  const query = useQuery({
    ...getUserTrafficHistoryOptions({ path: { username }, query: { range } }),
    refetchInterval: 60_000,
  });
  const data = query.data;
  const summary = trafficHistorySummary(data?.points ?? []);

  return (
    <section className="rounded-xl bg-bg px-3.5 py-3" data-testid="person-traffic-history">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-meta font-semibold text-text">{s.people.trafficHistory.title}</h3>
          <p className="mt-0.5 text-micro leading-relaxed text-text-muted">
            {s.people.trafficHistory.subtitle}
          </p>
        </div>
        <div className="flex rounded-lg bg-surface p-0.5" role="group" aria-label={s.people.trafficHistory.title}>
          {(["24h", "7d", "30d"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setRange(value)}
              aria-pressed={range === value}
              className={cn(
                "min-h-8 rounded-md px-2 text-[10px] font-semibold transition-colors",
                range === value ? "bg-surface-3 text-text shadow-sm" : "text-text-muted hover:text-text",
              )}
            >
              {s.people.trafficHistory.ranges[value]}
            </button>
          ))}
        </div>
      </div>

      {query.isPending ? (
        <Skeleton className="mt-3 h-28 w-full rounded-lg" />
      ) : query.isError || !data ? (
        <HistoryNote tone="warn" text={s.people.trafficHistory.sourceUnavailable} />
      ) : data.state === "disabled" ? (
        <div className="mt-3 rounded-lg border border-dashed border-border-strong px-3 py-4">
          <p className="text-meta font-semibold text-text">{s.people.trafficHistory.disabled}</p>
          <p className="mt-1 text-micro leading-relaxed text-text-muted">
            {s.people.trafficHistory.disabledHint}
          </p>
        </div>
      ) : data.state === "empty" ? (
        <HistoryNote tone="muted" text={s.people.trafficHistory.empty} />
      ) : (
        <>
          {data.source_available === false && (
            <HistoryNote tone="warn" text={s.people.trafficHistory.sourceUnavailable} />
          )}
          <TrafficBars points={data.points} label={s.people.trafficHistory.title} />
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
            <HistoryValue label={s.people.trafficHistory.total} value={formatBytes(summary.total, s)} />
            <HistoryValue label={s.people.trafficHistory.peak} value={formatBytes(summary.peak, s)} />
          </div>
          <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-text-muted">
            <span>
              {data.points.some((point) => point.tier === "1h")
                ? s.people.trafficHistory.bucketHour
                : s.people.trafficHistory.bucket15m}
            </span>
            {data.state === "partial" && <span className="text-accent">{s.people.trafficHistory.partial}</span>}
          </div>
        </>
      )}
    </section>
  );
}

function TrafficBars({ points, label }: { points: Array<{ ts: number; v: number }>; label: string }) {
  const heights = trafficBarHeights(points);
  if (heights.length === 0) return null;
  const width = 720;
  const height = 104;
  const step = width / heights.length;
  const barWidth = Math.max(0.7, step * 0.72);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="mt-3 h-[104px] w-full overflow-visible rounded-lg bg-surface px-1 pt-2"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id="person-traffic-bars" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="rgb(var(--accent))" stopOpacity="0.85" />
          <stop offset="1" stopColor="rgb(var(--accent))" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      {heights.map((value, index) => {
        const barHeight = Math.max(value > 0 ? 2 : 0, value * (height - 12));
        return (
          <rect
            key={`${points[index]?.ts ?? index}`}
            x={index * step + (step - barWidth) / 2}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            rx={Math.min(2, barWidth / 2)}
            fill="url(#person-traffic-bars)"
          />
        );
      })}
    </svg>
  );
}

function HistoryValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[10px] text-text-muted">{label}</span>
      <strong className="mt-0.5 block text-meta tabular-nums text-text">{value}</strong>
    </div>
  );
}

function HistoryNote({ tone, text }: { tone: "warn" | "muted"; text: string }) {
  return (
    <p
      className={cn(
        "mt-3 rounded-lg px-3 py-3 text-micro leading-relaxed",
        tone === "warn" ? "bg-warn/10 text-warn" : "bg-surface text-text-muted",
      )}
    >
      {text}
    </p>
  );
}
