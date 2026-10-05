import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getHistoryEventsOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import { fill, formatNumber, localeOf, useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type { StatsSnapshot, UsersTopic } from "../../realtime/topics";
import type { State } from "../../ui/StatePill";
import { IconCheck, IconWarning } from "../../ui/icons";
import { useDetailSources, type DetailSourceInput } from "../sourceState";
import { useHistorySeries } from "../useHistorySeries";
import { connectionQuality, historyWindowDelta, lastHistoryValue } from "../widgets/statRow.helpers";
import { resolveGated } from "../widgets/gated";
import { DetailHeader } from "./DetailHeader";
import { usersTrafficTotal } from "./connections.helpers";
import { connectionsSources } from "./sourceDefinitions";
import { formatDiagnosticDuration, formatPercent, formatRtt } from "../formatting";
import { LoadChart, THIRTY_MINUTES_SECONDS, type ChartReading } from "./ConnectionsChartSection";
import { ReasonRows, ClientRanking, type RankingMode } from "./ConnectionsClientSections";
import { TechnicalSection } from "./TechnicalSection";

function percent(value: number | null, s: Dict, digits = 1): string {
  return formatPercent(value, s, { precision: digits });
}

function formatUptime(seconds: number, s: Dict): string {
  return formatDiagnosticDuration(seconds, s, { inputUnit: "seconds", minimumUnit: "minutes", precision: 0, rounding: "floor" });
}

function historySpanSeconds(...series: ReadonlyArray<readonly ChartReading[]>): number {
  const timestamps = series.flatMap((items) => items.map((item) => item.ts));
  if (timestamps.length < 2) return 0;
  return Math.max(...timestamps) - Math.min(...timestamps);
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
  const eventsHistory = useQuery({
    ...getHistoryEventsOptions({ query: { range: "30m", limit: 50 } }),
    refetchInterval: 10_000,
  });
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
  const sources = useDetailSources(connectionsSources, inputs);

  const connectionReadings = connectionsHistory.data?.points ?? [];
  const activeUserReadings = activeUsersHistory.data?.points ?? [];
  const connectionValues = connectionReadings.map((point) => point.v);
  const chartEvents = (eventsHistory.data?.events ?? []).map((event) => ({
    ts: Math.floor(new Date(event.ts).getTime() / 1000),
    severity: event.severity,
  })).filter((event) => Number.isFinite(event.ts));
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
        ["cache.ttl_ms", live ? formatRtt(live.cache.ttl_ms, s, { precision: 3 }) : "—"],
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
      <DetailHeader
        title={s.details.pages.connections.title}
        description={s.details.pages.connections.description}
        status={sources.status}
        freshnessMs={sources.freshnessMs}
        nowMs={nowMs}
        onBack={() => void navigate({ to: "/pulse" })}
      />
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">

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
                  events={chartEvents}
                  s={s}
                />

                <div className="flex justify-between text-micro text-text-muted">
                  <span>{s.details.pages.connections.view.thirtyMinutesAgo}</span>
                  <span>{s.details.pages.connections.view.fifteenMinutesAgo}</span>
                  <span>{s.details.pages.connections.view.now}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-meta text-text-muted">
                  {connectionsHistory.data?.source_available === false && (
                    <span className="text-warn">{s.details.pages.connections.view.sourceUnavailable}</span>
                  )}
                  {eventsHistory.data?.state === "disabled" ? (
                    <span>{s.details.pages.connections.view.correlationDisabled}</span>
                  ) : chartEvents.length > 0 ? (
                    <span className="inline-flex items-center gap-1.5">
                      <i className="h-2 w-2 rounded-full bg-text-muted/60" />
                      {fill(s.details.pages.connections.view.correlatedEvents, {
                        count: formatNumber(s, chartEvents.length),
                      })}
                    </span>
                  ) : null}
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

            <TechnicalSection title={s.details.pages.connections.view.technical} data-testid="connections-technical" description={s.details.pages.connections.view.technicalDescription} className="group px-4 py-4 sm:px-5">
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
            </TechnicalSection>
          </>
        )}
      </section>
    </div>
  );
}
