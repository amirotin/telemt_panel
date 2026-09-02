import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatNumber, localeOf, useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamStatus, UpstreamsTopic } from "../../realtime/topics";
import { IconChevronDown, IconCheck, IconWarning } from "../../ui/icons";
import { StatePill } from "../../ui/StatePill";
import { DetailHeader } from "../details-builder/DetailHeader";
import {
  connectSuccessPct,
  upstreamsPageDefinition,
} from "../details-builder/definitions/upstreams";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { upstreamsPagePayload } from "./upstreams.helpers";

const HIGH_RTT_MS = 250;

function routeKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    direct: "Direct",
    socks4: "SOCKS4",
    socks5: "SOCKS5",
    shadowsocks: "Shadowsocks",
  };
  return labels[kind.toLowerCase()] ?? kind;
}

function routeKindMark(kind: string): string {
  const marks: Record<string, string> = {
    direct: "D",
    socks4: "S4",
    socks5: "S5",
    shadowsocks: "SS",
  };
  return marks[kind.toLowerCase()] ?? kind.slice(0, 2).toUpperCase();
}

function scopeLabel(scopes: string, s: Dict): string {
  const normalized = scopes.trim().toLowerCase();
  if (normalized === "" || normalized === "all" || normalized === "*" || normalized === "any") {
    return s.details.pages.upstreams.view.generalPool;
  }
  return scopes;
}

function formatMilliseconds(value: number | null | undefined, s: Dict): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const formatted = new Intl.NumberFormat(localeOf(s), {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
  return `${formatted} ${s.details.pages.upstreams.view.ms}`;
}

function formatDurationMs(value: number, s: Dict): string {
  if (value >= 1000 && value % 1000 === 0) {
    return `${formatNumber(s, value / 1000)} ${s.details.pages.upstreams.view.secondsShort}`;
  }
  return formatMilliseconds(value, s);
}

function formatPercent(value: number | null, s: Dict): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(localeOf(s), { maximumFractionDigits: 2 }).format(value)} %`;
}

function RouteMark({ route }: { route: UpstreamStatus }) {
  return (
    <span
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-lg font-mono text-micro font-bold",
        route.healthy ? "bg-accent/12 text-accent" : "bg-warn/15 text-warn",
      )}
      aria-hidden="true"
    >
      {routeKindMark(route.route_kind)}
    </span>
  );
}

function DcLatencyChart({ route, s }: { route: UpstreamStatus; s: Dict }) {
  const values = route.dc
    .map((entry) => entry.latency_ema_ms)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const maximum = Math.max(HIGH_RTT_MS, ...values, 1) * 1.08;

  if (route.dc.length === 0) {
    return (
      <p className="grid min-h-44 place-items-center text-meta text-text-muted">
        {s.details.pages.upstreams.view.noDcLatency}
      </p>
    );
  }

  return (
    <div
      className="mt-5 grid min-h-48 grid-cols-5 items-end gap-2 sm:gap-4"
      data-testid="upstreams-dc-latency"
      role="img"
      aria-label={s.details.pages.upstreams.view.dcLatencyChartLabel}
    >
      {route.dc.map((entry) => {
        const latency = entry.latency_ema_ms;
        const high = latency !== null && latency >= HIGH_RTT_MS;
        const height = latency === null ? 4 : Math.max(7, (latency / maximum) * 100);
        return (
          <div key={entry.dc} className="flex min-w-0 flex-col items-center text-center">
            <div className="flex h-28 w-full max-w-12 items-end rounded-md bg-surface-3 p-1">
              <span
                className={cn(
                  "block w-full rounded-sm transition-[height]",
                  latency === null ? "bg-muted/30" : high ? "bg-warn" : "bg-accent",
                )}
                style={{ height: `${height}%` }}
              />
            </div>
            <strong
              className={cn(
                "mt-2 whitespace-nowrap text-meta tabular-nums",
                high ? "text-warn" : "text-text",
              )}
            >
              {formatMilliseconds(latency, s)}
            </strong>
            <span className="mt-0.5 text-micro font-semibold text-text-muted">DC {entry.dc}</span>
            <span className="mt-0.5 min-h-7 break-words text-[11.5px] leading-tight text-text-faint">
              {entry.ip_preference && entry.ip_preference.toLowerCase() !== "unknown"
                ? entry.ip_preference
                : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function UpstreamsPage() {
  const s = useStrings();
  const navigate = useNavigate();
  const nowMs = useNow();
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [onlyUnhealthy, setOnlyUnhealthy] = useState(false);

  const stats = upstreams.data?.upstreams ?? null;
  const quality = runtime.data?.upstream_quality ?? null;
  const payload = upstreamsPagePayload(stats, quality);

  const inputs: Record<string, DetailSourceInput> = {
    upstreams: {
      kind: "topic",
      snapshot: upstreams,
      ...(stats
        ? {
            gated: {
              enabled: stats.enabled,
              ...(stats.reason !== undefined ? { reason: stats.reason } : {}),
              data: stats,
            },
          }
        : {}),
      generatedAt: stats?.generated_at_epoch_secs ?? null,
    },
    quality: {
      kind: "topic",
      snapshot: runtime,
      ...(quality
        ? {
            gated: {
              enabled: quality.enabled,
              ...(quality.reason !== undefined ? { reason: quality.reason } : {}),
              data: quality.policy,
            },
          }
        : {}),
      generatedAt: quality?.generated_at_epoch_secs ?? null,
    },
  };
  const sources = useDetailSources(upstreamsPageDefinition.sources, inputs);

  const routes = payload?.upstreams ?? [];
  const selected = routes.find((route) => route.upstream_id === selectedId) ?? routes[0] ?? null;
  const visibleRoutes = onlyUnhealthy ? routes.filter((route) => !route.healthy) : routes;
  const summary = payload?.summary;
  const configured = summary?.configured_total ?? routes.length;
  const healthy = summary?.healthy_total ?? routes.filter((route) => route.healthy).length;
  const unhealthy = summary?.unhealthy_total ?? Math.max(0, configured - healthy);
  const policy = payload?.upstream_quality?.policy ?? null;
  const zero = payload?.zero;
  const successPct = connectSuccessPct(zero);

  const poolsByScope = new Map<string, { total: number; healthy: number }>();
  const countsByKind = new Map<string, number>();
  for (const route of routes) {
    const poolLabel = scopeLabel(route.scopes, s);
    const pool = poolsByScope.get(poolLabel) ?? { total: 0, healthy: 0 };
    pool.total += 1;
    if (route.healthy) pool.healthy += 1;
    poolsByScope.set(poolLabel, pool);

    const kindLabel = routeKindLabel(route.route_kind);
    countsByKind.set(kindLabel, (countsByKind.get(kindLabel) ?? 0) + 1);
  }
  const pools = [...poolsByScope.entries()];
  const routeKinds = [...countsByKind.entries()];

  const technical: Array<[string, string]> = [
    ["stats.enabled", stats === null ? "—" : String(stats.enabled)],
    ["stats.reason", stats?.reason ?? "—"],
    ["quality.enabled", quality === null ? "—" : String(quality.enabled)],
    ["quality.reason", quality?.reason ?? "—"],
    [
      "connect_attempt_total",
      zero?.connect_attempt_total === undefined ? "—" : formatNumber(s, zero.connect_attempt_total),
    ],
    [
      "connect_success_total",
      zero?.connect_success_total === undefined ? "—" : formatNumber(s, zero.connect_success_total),
    ],
    [
      "connect_fail_total",
      zero?.connect_fail_total === undefined ? "—" : formatNumber(s, zero.connect_fail_total),
    ],
    [
      "connect_failfast_hard_error_total",
      zero?.connect_failfast_hard_error_total === undefined
        ? "—"
        : formatNumber(s, zero.connect_failfast_hard_error_total),
    ],
    [
      "connect_retry_attempts",
      policy === null ? "—" : formatNumber(s, policy.connect_retry_attempts),
    ],
    [
      "connect_retry_backoff_ms",
      policy === null ? "—" : formatMilliseconds(policy.connect_retry_backoff_ms, s),
    ],
    ["connect_budget_ms", policy === null ? "—" : formatMilliseconds(policy.connect_budget_ms, s)],
    [
      "unhealthy_fail_threshold",
      policy === null ? "—" : formatNumber(s, policy.unhealthy_fail_threshold),
    ],
    [
      "connect_failfast_hard_errors",
      policy === null ? "—" : String(policy.connect_failfast_hard_errors),
    ],
  ];

  return (
    <div className="w-full" data-testid="upstreams-detail">
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <DetailHeader
            title={s.details.pages.upstreams.title}
            description={s.details.pages.upstreams.description}
            status={sources.status}
            freshnessMs={sources.freshnessMs}
            nowMs={nowMs}
            onBack={() => void navigate({ to: "/pulse" })}
          />
        </div>

        {payload === null ? (
          <div className="grid min-h-56 place-items-center px-5 text-center">
            <div>
              <p className="text-h3 font-semibold text-text">
                {upstreams.error
                  ? s.details.pages.upstreams.view.sourceUnavailable
                  : s.details.pages.upstreams.view.loading}
              </p>
              <p className="mt-1 text-meta text-text-muted">
                {upstreams.error ?? s.details.pages.upstreams.view.loadingDescription}
              </p>
            </div>
          </div>
        ) : (
          <>
            <section
              className={cn(
                "grid gap-4 border-b border-border px-4 py-5 sm:px-5 lg:grid-cols-[230px_minmax(0,1fr)_auto] lg:items-center",
                unhealthy > 0 ? "bg-warn/[0.045]" : "bg-ok/[0.035]",
              )}
              data-testid="upstreams-selection"
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "grid h-11 w-11 shrink-0 place-items-center rounded-full",
                    unhealthy > 0 ? "bg-warn/15 text-warn" : "bg-ok/15 text-ok",
                  )}
                >
                  {unhealthy > 0 ? <IconWarning /> : <IconCheck />}
                </span>
                <div>
                  <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                    {s.details.pages.upstreams.view.availableForSelection}
                  </p>
                  <strong className="mt-0.5 block text-[1.75rem] leading-none tabular-nums text-text">
                    {formatNumber(s, healthy)} {s.details.pages.upstreams.view.of}{" "}
                    {formatNumber(s, configured)}
                  </strong>
                </div>
              </div>

              <div className="min-w-0 lg:border-l lg:border-border lg:pl-5">
                <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                  {s.details.pages.upstreams.view.howSelectionWorks}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta font-semibold text-text">
                  <span>{s.details.pages.upstreams.view.scope}</span>
                  <span className="text-accent">→</span>
                  <span>{s.details.pages.upstreams.view.health}</span>
                  <span className="text-accent">→</span>
                  <span>{s.details.pages.upstreams.view.weightAndRtt}</span>
                  <span className="text-accent">→</span>
                  <span>{s.details.pages.upstreams.view.randomChoice}</span>
                </p>
                <p className="mt-1 text-micro leading-relaxed text-text-muted">
                  {s.details.pages.upstreams.view.selectionDescription}
                </p>
              </div>

              <div className="flex flex-wrap gap-2 lg:max-w-56 lg:justify-end">
                {pools.map(([label, state]) => (
                  <span
                    key={label}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-micro font-semibold",
                      state.healthy === 0 ? "bg-warn/15 text-warn" : "bg-surface-3 text-text-muted",
                    )}
                  >
                    {label} {state.healthy}/{state.total}
                  </span>
                ))}
              </div>
            </section>

            {routes.length === 0 ? (
              <div className="grid min-h-64 place-items-center px-5 text-center">
                <div>
                  <p className="text-h3 font-semibold text-text">
                    {s.details.pages.upstreams.view.noRoutes}
                  </p>
                  <p className="mt-1 max-w-lg text-meta text-text-muted">
                    {s.details.pages.upstreams.view.noRoutesDescription}
                  </p>
                </div>
              </div>
            ) : (
              <section className="grid border-b border-border lg:grid-cols-[minmax(300px,0.42fr)_minmax(0,1fr)]">
                <aside
                  className="min-w-0 border-b border-border lg:border-b-0 lg:border-r"
                  data-testid="upstreams-routes"
                >
                  <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
                    <div>
                      <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                        {s.details.pages.upstreams.view.routes}
                      </p>
                      <h2 className="mt-0.5 text-h3 font-semibold text-text">
                        {formatNumber(s, configured)} {s.details.pages.upstreams.view.configured}
                      </h2>
                    </div>
                    <button
                      type="button"
                      className={cn(
                        "tap-target rounded-lg border px-2.5 text-micro font-semibold transition-colors",
                        onlyUnhealthy
                          ? "border-warn/50 bg-warn/10 text-warn"
                          : "border-border text-text-muted hover:bg-surface-2 hover:text-text",
                      )}
                      aria-pressed={onlyUnhealthy}
                      onClick={() => setOnlyUnhealthy((value) => !value)}
                    >
                      {s.details.pages.upstreams.filterUnhealthy}
                    </button>
                  </header>

                  <div className="flex flex-col gap-1 px-2 pb-3 sm:px-3">
                    {visibleRoutes.map((route) => (
                      <button
                        key={route.upstream_id}
                        type="button"
                        data-upstream-route={route.upstream_id}
                        className={cn(
                          "grid min-h-16 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors",
                          selected?.upstream_id === route.upstream_id
                            ? "bg-accent/10 ring-1 ring-inset ring-accent/25"
                            : "hover:bg-surface-2",
                        )}
                        aria-pressed={selected?.upstream_id === route.upstream_id}
                        onClick={() => setSelectedId(route.upstream_id)}
                      >
                        <RouteMark route={route} />
                        <span className="min-w-0">
                          <strong className="block truncate text-meta text-text">
                            Upstream #{route.upstream_id} · {routeKindLabel(route.route_kind)}
                          </strong>
                          <span
                            className="block truncate text-micro text-text-muted"
                            title={route.address}
                          >
                            {route.address} · {scopeLabel(route.scopes, s)}
                          </span>
                        </span>
                        <span className="text-right">
                          <strong
                            className={cn(
                              "block whitespace-nowrap text-meta tabular-nums",
                              route.effective_latency_ms !== null &&
                                route.effective_latency_ms >= HIGH_RTT_MS
                                ? "text-warn"
                                : "text-text",
                            )}
                          >
                            {formatMilliseconds(route.effective_latency_ms, s)}
                          </strong>
                          <span
                            className={cn(
                              "block text-micro",
                              route.healthy ? "text-ok" : "text-warn",
                            )}
                          >
                            {route.healthy
                              ? s.details.pages.upstreams.view.eligible
                              : s.details.pages.upstreams.view.excluded}
                          </span>
                        </span>
                      </button>
                    ))}
                    {visibleRoutes.length === 0 && (
                      <p className="rounded-lg bg-surface-2 px-3 py-5 text-center text-meta text-text-muted">
                        {s.details.pages.upstreams.view.noUnhealthy}
                      </p>
                    )}
                  </div>

                  <footer className="flex flex-wrap gap-2 border-t border-border px-4 py-3 sm:px-5">
                    {routeKinds.map(([kind, count]) => (
                      <span key={kind} className="text-micro text-text-muted">
                        <strong className="text-text">{kind}</strong> {formatNumber(s, count)}
                      </span>
                    ))}
                  </footer>
                </aside>

                {selected && (
                  <div className="min-w-0" data-testid="upstreams-route-detail">
                    <header className="flex flex-wrap items-start justify-between gap-4 px-4 py-5 sm:px-5">
                      <div className="flex min-w-0 items-center gap-3">
                        <RouteMark route={selected} />
                        <div className="min-w-0">
                          <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                            {routeKindLabel(selected.route_kind)}
                          </p>
                          <h2 className="text-h2 font-semibold text-text">
                            Upstream #{selected.upstream_id}
                          </h2>
                          <p
                            className="truncate text-meta text-text-muted"
                            title={selected.address}
                          >
                            {selected.address}
                          </p>
                        </div>
                      </div>
                      <StatePill state={selected.healthy ? "ok" : "warn"}>
                        {selected.healthy
                          ? s.details.pages.upstreams.view.eligible
                          : s.details.pages.upstreams.view.excludedFromSelection}
                      </StatePill>
                    </header>

                    <div className="grid grid-cols-2 border-y border-border sm:grid-cols-4">
                      <div className="min-w-0 border-b border-r border-border px-3 py-3 sm:border-b-0 sm:px-4">
                        <p className="text-micro text-text-muted">
                          {s.details.pages.upstreams.view.effectiveRtt}
                        </p>
                        <strong
                          className={cn(
                            "mt-1 block text-h3 tabular-nums",
                            selected.effective_latency_ms !== null &&
                              selected.effective_latency_ms >= HIGH_RTT_MS
                              ? "text-warn"
                              : "text-text",
                          )}
                        >
                          {formatMilliseconds(selected.effective_latency_ms, s)}
                        </strong>
                        <p className="mt-0.5 text-[11.5px] leading-tight text-text-faint">
                          {s.details.pages.upstreams.view.availableDcAverage}
                        </p>
                      </div>
                      <div className="min-w-0 border-b border-border px-3 py-3 sm:border-b-0 sm:border-r sm:px-4">
                        <p className="text-micro text-text-muted">
                          {s.details.pages.upstreams.view.failureStreak}
                        </p>
                        <strong
                          className={cn(
                            "mt-1 block text-h3 tabular-nums",
                            selected.fails > 0 ? "text-warn" : "text-text",
                          )}
                        >
                          {formatNumber(s, selected.fails)}
                          {policy ? ` / ${formatNumber(s, policy.unhealthy_fail_threshold)}` : ""}
                        </strong>
                        <p className="mt-0.5 text-[11.5px] leading-tight text-text-faint">
                          {policy
                            ? s.details.pages.upstreams.view.untilExcluded
                            : s.details.pages.upstreams.view.consecutiveFailures}
                        </p>
                      </div>
                      <div className="min-w-0 border-r border-border px-3 py-3 sm:px-4">
                        <p className="text-micro text-text-muted">
                          {s.details.pages.upstreams.view.lastCheck}
                        </p>
                        <strong className="mt-1 block text-h3 tabular-nums text-text">
                          {formatNumber(s, selected.last_check_age_secs)}{" "}
                          {s.details.pages.upstreams.view.secondsAgo}
                        </strong>
                        <p className="mt-0.5 text-[11.5px] leading-tight text-text-faint">
                          {s.details.pages.upstreams.view.healthCheck}
                        </p>
                      </div>
                      <div className="min-w-0 px-3 py-3 sm:px-4">
                        <p className="text-micro text-text-muted">
                          {s.details.pages.upstreams.view.routeWeight}
                        </p>
                        <strong className="mt-1 block text-h3 tabular-nums text-text">
                          {formatNumber(s, selected.weight)}
                        </strong>
                        <p
                          className="mt-0.5 truncate text-[11.5px] leading-tight text-text-faint"
                          title={selected.scopes}
                        >
                          {scopeLabel(selected.scopes, s)}
                        </p>
                      </div>
                    </div>

                    <section className="px-4 py-5 sm:px-5">
                      <div className="flex flex-wrap items-end justify-between gap-2">
                        <div>
                          <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                            {s.details.pages.upstreams.view.byDirection}
                          </p>
                          <h3 className="mt-0.5 text-h3 font-semibold text-text">
                            {s.details.pages.upstreams.view.rttThroughRoute}
                          </h3>
                        </div>
                        <span className="text-micro text-text-muted">
                          EMA · {s.details.pages.upstreams.view.lowerIsBetter}
                        </span>
                      </div>
                      <DcLatencyChart route={selected} s={s} />
                    </section>

                    <footer
                      className={cn(
                        "mx-4 mb-5 flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-meta leading-relaxed sm:mx-5",
                        selected.healthy ? "bg-accent/8 text-text-muted" : "bg-warn/10 text-warn",
                      )}
                    >
                      <span className="mt-px font-semibold" aria-hidden="true">
                        {selected.healthy ? "i" : "!"}
                      </span>
                      <p>
                        {selected.healthy
                          ? s.details.pages.upstreams.view.routeParticipates
                          : s.details.pages.upstreams.view.routeExcluded}
                      </p>
                    </footer>
                  </div>
                )}
              </section>
            )}

            <section className="grid border-b border-border lg:grid-cols-[minmax(0,1.15fr)_minmax(310px,0.85fr)]">
              <div
                className="min-w-0 border-b border-border px-4 py-5 sm:px-5 lg:border-b-0 lg:border-r"
                data-testid="upstreams-quality"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                      {s.details.pages.upstreams.view.telegramConnections}
                    </p>
                    <h2 className="mt-0.5 text-h3 font-semibold text-text">
                      {s.details.pages.upstreams.view.attemptHistory}
                    </h2>
                  </div>
                  <span className="text-micro text-text-muted">
                    {s.details.pages.upstreams.view.lifetime}
                  </span>
                </div>

                <div className="mt-5 grid gap-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
                  <div>
                    <strong className="block text-[2rem] font-bold leading-none tabular-nums text-text">
                      {formatPercent(successPct, s)}
                    </strong>
                    <span className="mt-1 block text-meta leading-snug text-text-muted">
                      {s.details.pages.upstreams.view.attemptsSucceeded}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
                    <div>
                      <dt className="text-micro text-text-muted">
                        {s.details.pages.upstreams.view.attempts}
                      </dt>
                      <dd className="mt-0.5 text-h3 font-semibold tabular-nums text-text">
                        {zero?.connect_attempt_total === undefined
                          ? "—"
                          : formatNumber(s, zero.connect_attempt_total)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-micro text-text-muted">
                        {s.details.pages.upstreams.view.successful}
                      </dt>
                      <dd className="mt-0.5 text-h3 font-semibold tabular-nums text-ok">
                        {zero?.connect_success_total === undefined
                          ? "—"
                          : formatNumber(s, zero.connect_success_total)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-micro text-text-muted">
                        {s.details.pages.upstreams.view.exhaustedCycles}
                      </dt>
                      <dd
                        className={cn(
                          "mt-0.5 text-h3 font-semibold tabular-nums",
                          (zero?.connect_fail_total ?? 0) > 0 ? "text-warn" : "text-text",
                        )}
                      >
                        {zero?.connect_fail_total === undefined
                          ? "—"
                          : formatNumber(s, zero.connect_fail_total)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-micro text-text-muted">
                        {s.details.pages.upstreams.view.hardErrors}
                      </dt>
                      <dd
                        className={cn(
                          "mt-0.5 text-h3 font-semibold tabular-nums",
                          (zero?.connect_failfast_hard_error_total ?? 0) > 0
                            ? "text-warn"
                            : "text-text",
                        )}
                      >
                        {zero?.connect_failfast_hard_error_total === undefined
                          ? "—"
                          : formatNumber(s, zero.connect_failfast_hard_error_total)}
                      </dd>
                    </div>
                  </dl>
                </div>
                <p className="mt-4 border-t border-border pt-3 text-micro leading-relaxed text-text-muted">
                  {s.details.pages.upstreams.view.counterExplanation}
                </p>
              </div>

              <div className="min-w-0 px-4 py-5 sm:px-5" data-testid="upstreams-policy">
                <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                  {s.details.pages.upstreams.view.policy}
                </p>
                <h2 className="mt-0.5 text-h3 font-semibold text-text">
                  {s.details.pages.upstreams.view.failureHandling}
                </h2>
                {policy ? (
                  <>
                    <div className="mt-5 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 text-center">
                      <div className="rounded-lg bg-surface-2 px-2 py-3">
                        <strong className="block text-h3 tabular-nums text-text">
                          {formatNumber(s, policy.connect_retry_attempts)}
                        </strong>
                        <span className="text-micro text-text-muted">
                          {s.details.pages.upstreams.view.retryAttempts}
                        </span>
                      </div>
                      <span className="text-accent">→</span>
                      <div className="rounded-lg bg-surface-2 px-2 py-3">
                        <strong className="block text-h3 tabular-nums text-text">
                          {formatMilliseconds(policy.connect_retry_backoff_ms, s)}
                        </strong>
                        <span className="text-micro text-text-muted">backoff</span>
                      </div>
                      <span className="text-accent">→</span>
                      <div className="rounded-lg bg-surface-2 px-2 py-3">
                        <strong className="block text-h3 tabular-nums text-text">
                          {formatDurationMs(policy.connect_budget_ms, s)}
                        </strong>
                        <span className="text-micro text-text-muted">
                          {s.details.pages.upstreams.view.totalBudget}
                        </span>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-meta text-text-muted">
                      <span>{s.details.pages.upstreams.view.excludedAfter}</span>
                      <strong className="text-text">
                        {formatNumber(s, policy.unhealthy_fail_threshold)}{" "}
                        {s.details.pages.upstreams.view.failedCyclesInRow}
                      </strong>
                    </div>
                  </>
                ) : (
                  <p className="mt-5 rounded-lg bg-surface-2 px-3.5 py-4 text-meta leading-relaxed text-text-muted">
                    {s.details.pages.upstreams.view.policyUnavailable}
                  </p>
                )}
              </div>
            </section>

            <details className="group px-4 py-4 sm:px-5" data-testid="upstreams-technical">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <span>
                  <strong className="block text-meta text-text">
                    {s.details.pages.upstreams.view.technical}
                  </strong>
                  <span className="block text-micro text-text-muted">
                    {s.details.pages.upstreams.view.technicalDescription}
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
