import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { fill, formatNumber, localeOf, useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type {
  ClassCount,
  RuntimeEdgeConnectionUser,
  StatsSnapshot,
  UsersTopic,
} from "../../realtime/topics";
import type { State } from "../../ui/StatePill";
import { IconCheck, IconChevronDown, IconWarning } from "../../ui/icons";
import { DetailHeader } from "../details-builder/DetailHeader";
import { connectionsPageDefinition } from "../details-builder/definitions/connections";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { useHistorySeries } from "../useHistorySeries";
import {
  connectionQuality,
  historyWindowDelta,
  lastHistoryValue,
} from "../widgets/statRow.helpers";
import { resolveGated } from "../widgets/gated";
import { usersTrafficTotal } from "./connections.helpers";

const THIRTY_MINUTES_SECONDS = 30 * 60;

type RankingMode = "current" | "traffic";

function percent(value: number | null, s: Dict, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(localeOf(s), { maximumFractionDigits: digits }).format(value)} %`;
}

function formatUptime(seconds: number, s: Dict): string {
  const days = Math.floor(seconds / 86_400);
  if (days > 0) return `${formatNumber(s, days)} ${s.details.pages.connections.view.daysShort}`;
  const hours = Math.floor(seconds / 3_600);
  if (hours > 0) return `${formatNumber(s, hours)} ${s.details.pages.connections.view.hoursShort}`;
  const minutes = Math.floor(seconds / 60);
  return `${formatNumber(s, minutes)} ${s.details.pages.connections.view.minutesShort}`;
}

function classLabel(name: string, s: Dict): string {
  const labels: Record<string, string> = {
    tls_handshake_bad_client: s.details.pages.connections.view.badTlsClient,
    tls_mtproto_bad_client: s.details.pages.connections.view.badMtprotoClient,
    direct_modes_disabled: s.details.pages.connections.view.directDisabled,
  };
  return labels[name] ?? name.replaceAll("_", " ");
}

interface ChartReading {
  ts: number;
  v: number;
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

function historySpanSeconds(...series: ReadonlyArray<readonly ChartReading[]>): number {
  const timestamps = series.flatMap((items) => items.map((item) => item.ts));
  if (timestamps.length < 2) return 0;
  return Math.max(...timestamps) - Math.min(...timestamps);
}

function pathOf(entries: readonly { x: number; y: number }[]): string {
  return entries
    .map((entry, index) => `${index === 0 ? "M" : "L"}${entry.x.toFixed(1)},${entry.y.toFixed(1)}`)
    .join(" ");
}

function LoadChart({
  connections,
  activeUsers,
  label,
  emptyLabel,
  s,
}: {
  connections: readonly ChartReading[];
  activeUsers: readonly ChartReading[];
  label: string;
  emptyLabel: string;
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

function ReasonRows({ rows, total, s }: { rows: readonly ClassCount[]; total: number; s: Dict }) {
  const ordered = useMemo(() => [...rows].sort((a, b) => b.total - a.total).slice(0, 4), [rows]);

  if (ordered.length === 0) {
    return <p className="mt-5 text-meta text-text-muted">{s.details.pages.connections.view.noReasons}</p>;
  }

  return (
    <div className="mt-5 flex flex-col gap-4" data-testid="connections-reasons">
      {ordered.map((row) => {
        const share = total > 0 ? (row.total / total) * 100 : 0;
        return (
          <div key={row.class}>
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-meta font-semibold text-text" title={classLabel(row.class, s)}>
                  {classLabel(row.class, s)}
                </p>
                <p className="truncate font-mono text-micro text-text-muted" title={row.class}>
                  {row.class}
                </p>
              </div>
              <span className="shrink-0 text-meta font-semibold tabular-nums text-text">
                {formatNumber(s, row.total)}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.max(1.5, Math.min(100, share))}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ClientRanking({
  rows,
  mode,
  totalConnections,
  s,
}: {
  rows: readonly RuntimeEdgeConnectionUser[];
  mode: RankingMode;
  totalConnections: number | null;
  s: Dict;
}) {
  const visible = rows.slice(0, 5);
  const covered = visible.reduce((sum, row) => sum + row.current_connections, 0);
  const share = totalConnections && totalConnections > 0 ? (covered / totalConnections) * 100 : null;

  if (visible.length === 0) {
    return <p className="mt-5 text-meta text-text-muted">{s.details.pages.connections.view.noClients}</p>;
  }

  return (
    <>
      <ol className="mt-4 flex flex-col gap-1.5" data-testid="connections-clients">
        {visible.map((row, index) => (
          <li key={row.username}>
            <Link
              to="/people/$username"
              params={{ username: row.username }}
              className="group grid min-h-12 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-2 transition-colors hover:bg-surface-3"
            >
              <span className="text-micro tabular-nums text-text-muted">{index + 1}</span>
              <span className="min-w-0">
                <strong className="block truncate text-meta text-text group-hover:text-accent">
                  {row.username}
                </strong>
                <span className="block truncate text-micro text-text-muted">
                  {formatBytes(row.total_octets, s)} {s.details.pages.connections.view.sinceStart}
                </span>
              </span>
              <span className="text-right">
                <strong className="block text-meta tabular-nums text-text">
                  {mode === "current"
                    ? formatNumber(s, row.current_connections)
                    : formatBytes(row.total_octets, s)}
                </strong>
                <span className="block text-micro text-text-muted">
                  {mode === "current"
                    ? s.details.pages.connections.view.connections
                    : s.details.pages.connections.view.traffic}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {totalConnections !== null && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-micro text-text-muted">
          <span>
            {s.details.pages.connections.view.topClients}: {formatNumber(s, covered)} / {formatNumber(s, totalConnections)}
          </span>
          <strong className="tabular-nums text-accent">{percent(share, s, 0)}</strong>
        </div>
      )}
    </>
  );
}

export function ConnectionsPage() {
  const s = useStrings();
  const navigate = useNavigate();
  const nowMs = useNow();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const users = useSnapshot<UsersTopic>("users");
  const connectionsHistory = useHistorySeries("connections", 10_000);
  const activeUsersHistory = useHistorySeries("active_users", 10_000);
  const attemptsHistory = useHistorySeries("attempts", 10_000);
  const refusalsHistory = useHistorySeries("refusals", 10_000);
  const [rankingMode, setRankingMode] = useState<RankingMode>("current");

  const gated = stats.data ? resolveGated(stats.data.connections_summary) : null;
  const live = gated?.status === "ok" ? gated.data : null;
  const summary = stats.data?.summary ?? null;

  const inputs: Record<string, DetailSourceInput> = {
    stats: { kind: "topic", snapshot: stats },
    connections: {
      kind: "topic",
      snapshot: stats,
      gated: stats.data?.connections_summary ?? null,
    },
  };
  const sources = useDetailSources(connectionsPageDefinition.sources, inputs);

  const connectionReadings = connectionsHistory.data?.points ?? [];
  const activeUserReadings = activeUsersHistory.data?.points ?? [];
  const connectionValues = connectionReadings.map((point) => point.v);
  const chartSpan = historySpanSeconds(connectionReadings, activeUserReadings);
  const chartMinutes = Math.max(1, Math.ceil(chartSpan / 60));
  const currentConnections =
    live?.totals.current_connections ?? lastHistoryValue(connectionsHistory.data) ?? null;
  const activeUsers = live?.totals.active_users ?? lastHistoryValue(activeUsersHistory.data) ?? null;
  const perUser =
    currentConnections !== null && activeUsers !== null && activeUsers > 0
      ? currentConnections / activeUsers
      : null;

  const attempts = historyWindowDelta(attemptsHistory.data);
  const quality = connectionQuality(
    attemptsHistory.data,
    refusalsHistory.data,
    THIRTY_MINUTES_SECONDS,
  );
  const refusals = quality.refusals;
  const accepted = attempts === null ? null : Math.max(0, attempts - refusals);
  const admissionSpan = historySpanSeconds(
    attemptsHistory.data?.points ?? [],
    refusalsHistory.data?.points ?? [],
  );
  const admissionMinutes = Math.max(1, Math.ceil(admissionSpan / 60));
  const chartWindowComplete = chartSpan >= THIRTY_MINUTES_SECONDS - 60;
  const admissionWindowComplete = admissionSpan >= THIRTY_MINUTES_SECONDS - 60;
  const admissionOpen = stats.data?.ready?.admission_open ?? null;
  const admissionState: State = admissionOpen === null ? "muted" : admissionOpen ? "ok" : "warn";

  const lifetimeAccepted = summary
    ? Math.max(0, summary.connections_total - summary.connections_bad_total)
    : null;
  const lifetimeQuality =
    summary && summary.connections_total > 0
      ? (lifetimeAccepted! / summary.connections_total) * 100
      : null;
  const reasons = summary?.connections_bad_by_class ?? [];
  const rankingRows =
    rankingMode === "current" ? (live?.top.by_connections ?? []) : (live?.top.by_throughput ?? []);

  const technical = summary
    ? [
        ["connections_total", formatNumber(s, summary.connections_total)],
        ["connections_bad_total", formatNumber(s, summary.connections_bad_total)],
        ["handshake_timeouts_total", formatNumber(s, summary.handshake_timeouts_total)],
        ["configured_users", formatNumber(s, summary.configured_users)],
        ["uptime_seconds", formatUptime(summary.uptime_seconds, s)],
        ["users_traffic_total", users.data ? formatBytes(usersTrafficTotal(users.data) ?? 0, s) : "—"],
        ["cache.ttl_ms", live ? `${formatNumber(s, live.cache.ttl_ms)} ms` : "—"],
        ["cache.served_from_cache", live ? String(live.cache.served_from_cache) : "—"],
        ["cache.stale_cache_used", live ? String(live.cache.stale_cache_used) : "—"],
        ["top.limit", live ? formatNumber(s, live.top.limit) : "—"],
        ["telemetry.user_enabled", live ? String(live.telemetry.user_enabled) : "—"],
        [
          "telemetry.throughput_is_cumulative",
          live ? String(live.telemetry.throughput_is_cumulative) : "—",
        ],
      ]
    : [];

  return (
    <div className="w-full" data-testid="connections-detail">
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <DetailHeader
            title={s.details.pages.connections.title}
            description={s.details.pages.connections.description}
            status={sources.status}
            freshnessMs={sources.freshnessMs}
            nowMs={nowMs}
            onBack={() => void navigate({ to: "/pulse" })}
          />
        </div>

        {stats.data === null ? (
          <div className="grid min-h-56 place-items-center px-5 text-center">
            <div>
              <p className="text-h3 font-semibold text-text">
                {stats.error
                  ? s.details.pages.connections.view.sourceUnavailable
                  : s.details.pages.connections.view.loading}
              </p>
              <p className="mt-1 text-meta text-text-muted">
                {stats.error ?? s.details.pages.connections.view.loadingDescription}
              </p>
            </div>
          </div>
        ) : (
          <>
            {live === null && (
              <div className="mx-4 mt-4 flex items-start gap-3 rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-meta text-text-muted sm:mx-5">
                <IconWarning className="mt-0.5 shrink-0 text-muted" />
                <p>{s.details.pages.connections.view.runtimeUnavailable}</p>
              </div>
            )}

            <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
              <section className="min-w-0 border-b border-border px-4 py-5 sm:px-5 lg:border-r">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                      {s.details.pages.connections.view.liveLoad}
                    </p>
                    <div className="mt-1 flex items-baseline gap-2">
                      <strong className="text-[2rem] font-bold leading-none tabular-nums text-text">
                        {currentConnections === null ? "—" : formatNumber(s, currentConnections)}
                      </strong>
                      <span className="text-meta text-text-muted">
                        {s.details.pages.connections.view.connectionsNow}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3 text-micro text-text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-0.5 w-5 bg-accent" />
                      {s.details.pages.connections.view.connections}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-0.5 w-5 bg-ok/80" />
                      {s.details.pages.connections.view.activeUsers}
                    </span>
                  </div>
                </div>

                <LoadChart
                  connections={connectionReadings}
                  activeUsers={activeUserReadings}
                  label={s.details.pages.connections.view.chartLabel}
                  emptyLabel={s.details.pages.connections.view.historyCollecting}
                  s={s}
                />

                <div className="flex justify-between text-micro text-text-muted">
                  <span>{s.details.pages.connections.view.thirtyMinutesAgo}</span>
                  <span>{s.details.pages.connections.view.fifteenMinutesAgo}</span>
                  <span>{s.details.pages.connections.view.now}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-meta text-text-muted">
                  {!chartWindowComplete && (
                    <span className="text-accent">
                      {fill(s.details.pages.connections.view.availableMinutes, {
                        minutes: formatNumber(s, chartMinutes),
                      })}
                    </span>
                  )}
                  <span>
                    {s.details.pages.connections.view.peak}{" "}
                    <strong className="tabular-nums text-text">
                      {connectionValues.length === 0
                        ? "—"
                        : formatNumber(s, Math.max(...connectionValues))}
                    </strong>
                  </span>
                  <span>
                    {s.details.pages.connections.view.activeUsers}{" "}
                    <strong className="tabular-nums text-text">
                      {activeUsers === null ? "—" : formatNumber(s, activeUsers)}
                    </strong>
                  </span>
                  <span>
                    {s.details.pages.connections.view.perUser}{" "}
                    <strong className="tabular-nums text-text">
                      {perUser === null
                        ? "—"
                        : new Intl.NumberFormat(localeOf(s), { maximumFractionDigits: 1 }).format(perUser)}
                    </strong>
                  </span>
                </div>
              </section>

              <aside className="flex flex-col justify-between border-b border-border px-4 py-5 sm:px-5" data-testid="connections-admission">
                <div>
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "grid h-9 w-9 place-items-center rounded-full",
                        admissionState === "ok"
                          ? "bg-ok/15 text-ok"
                          : admissionState === "warn"
                            ? "bg-warn/15 text-warn"
                            : "bg-muted/15 text-muted",
                      )}
                    >
                      {admissionOpen === false ? <IconWarning /> : <IconCheck />}
                    </span>
                    <div>
                      <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                        {s.details.pages.connections.view.admission}
                      </p>
                      <p
                        className={cn(
                          "text-h2 font-semibold",
                          admissionState === "ok"
                            ? "text-ok"
                            : admissionState === "warn"
                              ? "text-warn"
                              : "text-muted",
                        )}
                      >
                        {admissionOpen === null
                          ? s.details.pages.connections.view.unknown
                          : admissionOpen
                            ? s.details.pages.connections.view.open
                            : s.details.pages.connections.view.closed}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 max-w-[28rem] text-body leading-relaxed text-text-muted">
                    {admissionOpen === false
                      ? s.details.pages.connections.view.closedDescription
                      : s.details.pages.connections.view.openDescription}
                  </p>
                </div>

                <div className="mt-6 grid grid-cols-3 gap-3 border-t border-border pt-4">
                  <div>
                    <p className="text-micro text-text-muted">{s.details.pages.connections.view.attempts}</p>
                    <strong className="mt-1 block text-h3 tabular-nums text-text">
                      {attempts === null ? "—" : formatNumber(s, attempts)}
                    </strong>
                  </div>
                  <div>
                    <p className="text-micro text-text-muted">{s.details.pages.connections.view.refusals}</p>
                    <strong
                      className={cn(
                        "mt-1 block text-h3 tabular-nums",
                        refusals > 0 ? "text-warn" : "text-text",
                      )}
                    >
                      {attempts === null ? "—" : formatNumber(s, refusals)}
                    </strong>
                  </div>
                  <div>
                    <p className="text-micro text-text-muted">{s.details.pages.connections.view.accepted}</p>
                    <strong className="mt-1 block text-h3 tabular-nums text-ok">
                      {quality.percent === null ? "—" : percent(quality.percent, s, 1)}
                    </strong>
                  </div>
                </div>
                <p className="mt-2 text-micro text-text-muted">
                  {accepted === null
                    ? s.details.pages.connections.view.historyCollecting
                    : admissionWindowComplete
                      ? s.details.pages.connections.view.lastThirtyMinutes
                      : fill(s.details.pages.connections.view.lastAvailableMinutes, {
                          minutes: formatNumber(s, admissionMinutes),
                        })}
                </p>
              </aside>
            </div>

            <div className="grid lg:grid-cols-[minmax(0,1fr)_360px]">
              <section className="min-w-0 border-b border-border px-4 py-5 sm:px-5 lg:border-r">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                      {s.details.pages.connections.view.quality}
                    </p>
                    <h2 className="mt-1 text-h2 font-semibold text-text">
                      {s.details.pages.connections.badByClass}
                    </h2>
                  </div>
                  <span className="text-micro text-text-muted">
                    {s.details.pages.connections.view.sinceStart} · {summary ? formatUptime(summary.uptime_seconds, s) : "—"}
                  </span>
                </div>

                <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
                  <div>
                    <strong
                      className={cn(
                        "text-[1.75rem] font-bold tabular-nums",
                        lifetimeQuality !== null && lifetimeQuality < 95 ? "text-warn" : "text-ok",
                      )}
                    >
                      {percent(lifetimeQuality, s, 2)}
                    </strong>
                    <p className="text-micro text-text-muted">
                      {s.details.pages.connections.view.acceptanceLifetime}
                    </p>
                  </div>
                  <div className="text-right text-meta text-text-muted">
                    <p>
                      <strong className="tabular-nums text-text">
                        {lifetimeAccepted === null ? "—" : formatNumber(s, lifetimeAccepted)}
                      </strong>{" "}
                      {s.details.pages.connections.view.acceptedLower}
                    </p>
                    <p>
                      <strong className="tabular-nums text-text">
                        {summary ? formatNumber(s, summary.connections_bad_total) : "—"}
                      </strong>{" "}
                      {s.details.pages.connections.view.refusedLower}
                    </p>
                  </div>
                </div>

                <ReasonRows
                  rows={reasons}
                  total={summary?.connections_bad_total ?? 0}
                  s={s}
                />
                <p className="mt-5 border-t border-border pt-4 text-micro leading-relaxed text-text-muted">
                  {s.details.pages.connections.view.cumulativeExplanation}
                </p>
              </section>

              <section className="border-b border-border px-4 py-5 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                      {s.details.pages.connections.view.clients}
                    </p>
                    <h2 className="mt-1 text-h2 font-semibold text-text">
                      {s.details.pages.connections.view.loadCreators}
                    </h2>
                  </div>
                  <div className="inline-flex rounded-full border border-border bg-surface-2 p-0.5 text-micro">
                    {(["current", "traffic"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={rankingMode === mode}
                        onClick={() => setRankingMode(mode)}
                        className={cn(
                          "min-h-8 rounded-full px-2.5 py-1 font-semibold transition-colors",
                          rankingMode === mode
                            ? "bg-accent-soft text-accent"
                            : "text-text-muted hover:text-text",
                        )}
                      >
                        {mode === "current"
                          ? s.details.pages.connections.view.now
                          : s.details.pages.connections.view.traffic}
                      </button>
                    ))}
                  </div>
                </div>

                {live ? (
                  <ClientRanking
                    rows={rankingRows}
                    mode={rankingMode}
                    totalConnections={currentConnections}
                    s={s}
                  />
                ) : (
                  <p className="mt-5 rounded-lg bg-surface-2 px-3 py-4 text-meta leading-relaxed text-text-muted">
                    {s.details.pages.connections.view.clientsUnavailable}
                  </p>
                )}
              </section>
            </div>

            <details className="group px-4 py-4 sm:px-5" data-testid="connections-technical">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <span>
                  <strong className="block text-meta text-text">
                    {s.details.pages.connections.view.technical}
                  </strong>
                  <span className="block text-micro text-text-muted">
                    {s.details.pages.connections.view.technicalDescription}
                  </span>
                </span>
                <IconChevronDown className="shrink-0 transition-transform group-open:rotate-180" />
              </summary>
              <dl className="mt-4 grid border-t border-border sm:grid-cols-2 xl:grid-cols-3">
                {technical.map(([label, value]) => (
                  <div key={label} className="min-w-0 border-b border-border px-3 py-3 sm:border-r">
                    <dt className="truncate font-mono text-micro text-text-muted" title={label}>
                      {label}
                    </dt>
                    <dd className="mt-1 break-all text-meta font-semibold tabular-nums text-text">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </>
        )}
      </section>
    </div>
  );
}
