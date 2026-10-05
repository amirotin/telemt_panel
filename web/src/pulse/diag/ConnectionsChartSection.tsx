import type { HistoryEvent } from "../../lib/api/generated/types.gen";
import { formatNumber, type Dict } from "../../i18n";

export const THIRTY_MINUTES_SECONDS = 30 * 60;

export interface ChartReading {
  ts: number;
  v: number;
}

interface ChartEvent {
  ts: number;
  severity: HistoryEvent["severity"];
}

function niceScaleTicks(value: number): number[] {
  if (!Number.isFinite(value) || value <= 0) return [1, 0];
  const rawStep = value / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = factor * magnitude;
  const maximum = Math.ceil(value / step) * step;
  const intervals = Math.round(maximum / step);
  return Array.from({ length: intervals + 1 }, (_, index) => maximum - index * step);
}

function points(
  values: readonly ChartReading[],
  width: number,
  height: number,
  maximum: number,
  startTs: number,
) {
  const top = 18;
  const bottom = 18;
  const usable = height - top - bottom;
  return values.map((value) => ({
    x: Math.max(0, Math.min(width, ((value.ts - startTs) / THIRTY_MINUTES_SECONDS) * width)),
    y: top + (1 - value.v / Math.max(1, maximum)) * usable,
  }));
}

function pathOf(entries: readonly { x: number; y: number }[]): string {
  return entries
    .map((entry, index) => `${index === 0 ? "M" : "L"}${entry.x.toFixed(1)},${entry.y.toFixed(1)}`)
    .join(" ");
}

export function LoadChart({
  connections,
  activeUsers,
  label,
  emptyLabel,
  events,
  s,
}: {
  connections: readonly ChartReading[];
  activeUsers: readonly ChartReading[];
  label: string;
  emptyLabel: string;
  events: readonly ChartEvent[];
  s: Dict;
}) {
  const width = 760;
  const height = 230;
  const latestTs = Math.max(
    0,
    connections.at(-1)?.ts ?? 0,
    activeUsers.at(-1)?.ts ?? 0,
  );
  const startTs = latestTs - THIRTY_MINUTES_SECONDS;
  const scaleTicks = niceScaleTicks(
    Math.max(1, ...connections.map((point) => point.v), ...activeUsers.map((point) => point.v)),
  );
  const maximum = scaleTicks[0] ?? 1;
  const connectionPoints = points(connections, width, height, maximum, startTs);
  const userPoints = points(activeUsers, width, height, maximum, startTs);
  const connectionPath = pathOf(connectionPoints);
  const userPath = pathOf(userPoints);
  const baseline = height - 18;
  const hasSeries = connectionPoints.length >= 2 || userPoints.length >= 2;
  const eventMarkers = events
    .filter((event) => event.ts >= startTs && event.ts <= latestTs)
    .slice(0, 12)
    .map((event) => ({
      ...event,
      x: ((event.ts - startTs) / THIRTY_MINUTES_SECONDS) * width,
    }));

  return (
    <div className="relative mt-4 h-[190px] w-full sm:h-[222px]" data-testid="connections-chart">
      {!hasSeries && (
        <div className="absolute inset-0 grid place-items-center text-meta text-text-muted">
          {emptyLabel}
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible"
        role="img"
        aria-label={`${label}. 0–${formatNumber(s, maximum)}`}
      >
        <defs>
          <linearGradient id="connections-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgb(var(--accent))" stopOpacity="0.22" />
            <stop offset="1" stopColor="rgb(var(--accent))" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {scaleTicks.map((_, index) => {
          const fraction = scaleTicks.length <= 1 ? 0 : index / (scaleTicks.length - 1);
          return (
          <line
            key={index}
            x1="0"
            x2={width}
            y1={18 + fraction * (height - 36)}
            y2={18 + fraction * (height - 36)}
            stroke="rgb(var(--border))"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          );
        })}
        {eventMarkers.map((event, index) => (
          <g key={`${event.ts}-${index}`} data-testid="connections-event-marker">
            <line
              x1={event.x}
              x2={event.x}
              y1="18"
              y2={baseline}
              stroke={event.severity === "critical" ? "rgb(var(--error))" : event.severity === "warning" ? "rgb(var(--warn))" : "rgb(var(--text-muted))"}
              strokeOpacity={event.severity === "info" ? "0.28" : "0.48"}
              strokeDasharray="3 4"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={event.x}
              cy="18"
              r="2.75"
              fill={event.severity === "critical" ? "rgb(var(--error))" : event.severity === "warning" ? "rgb(var(--warn))" : "rgb(var(--text-muted))"}
            />
          </g>
        ))}
        {connectionPoints.length >= 2 && (
          <>
            <path
              d={`${connectionPath} L${connectionPoints.at(-1)?.x ?? width},${baseline} L${connectionPoints[0]?.x ?? 0},${baseline} Z`}
              fill="url(#connections-area)"
            />
            <path
              d={connectionPath}
              fill="none"
              stroke="rgb(var(--accent))"
              strokeWidth="2.25"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        {userPoints.length >= 2 && (
          <path
            d={userPath}
            fill="none"
            stroke="rgb(var(--ok))"
            strokeWidth="1.75"
            strokeOpacity="0.78"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {connectionPoints.length >= 2 && (
          <circle
            cx={connectionPoints.at(-1)?.x}
            cy={connectionPoints.at(-1)?.y}
            r="3.5"
            fill="rgb(var(--accent))"
          />
        )}
        {userPoints.length >= 2 && (
          <circle
            cx={userPoints.at(-1)?.x}
            cy={userPoints.at(-1)?.y}
            r="3"
            fill="rgb(var(--ok))"
          />
        )}
      </svg>
      <div
        className="pointer-events-none absolute inset-y-[8%] left-0 z-10 flex flex-col justify-between"
        aria-hidden="true"
        data-testid="connections-scale"
      >
        {scaleTicks.map((tick) => (
          <span
            key={tick}
            className="rounded-sm bg-surface/85 px-1 font-mono text-micro leading-none tabular-nums text-text-muted"
          >
            {formatNumber(s, tick)}
          </span>
        ))}
      </div>
    </div>
  );
}
