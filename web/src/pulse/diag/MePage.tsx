import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatNumber, useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type { MeWriterStatus, MeWritersData, RuntimeGates, RuntimeMePoolState, RuntimeMeQuality, RuntimeMeQualityDcRtt, RuntimeMeSelftest, RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { StatePill, type State } from "../../ui/StatePill";
import { useDetailSources, type DetailSourceInput } from "../sourceState";
import { resolveGated } from "../widgets/gated";
import { DetailHeader } from "./DetailHeader";
import { mePagePayload, meRouteMode, type MeRouteMode } from "./me.helpers";
import { meSources } from "./sourceDefinitions";
import { MeSourceNotice } from '../MeSourceNotice';
import { meAvailability, meAvailabilityText } from '../meAvailability';
import { formatRtt as diagnosticRtt, formatPercent as diagnosticPercent, formatRaw as diagnosticRaw } from "../formatting";
import { SectionHeading } from "./SectionHeading";
import { TechnicalSection } from "./TechnicalSection";
import { InitializationPanel } from "./MeInitializationSection";
import { RuntimePanel } from "./MeRuntimeSection";

type MeTab = "overview" | "writers" | "quality" | "initialization" | "runtime";
type WriterFilter = "all" | "active" | "degraded" | "draining";

interface DcRoutePoint {
  dc: number;
  rtt: number | null;
  writers: number;
  required: number | null;
  coverage: number | null;
}

interface DcPairPoint {
  id: number;
  rpc?: DcRoutePoint;
  media?: DcRoutePoint;
}

function formatRtt(value: number | null | undefined, s: Dict): string {
  return diagnosticRtt(value, s, { precision: "adaptive" });
}

function formatPercent(value: number | null | undefined, s: Dict): string {
  return diagnosticPercent(value, s, { precision: 1, space: false });
}

function formatRaw(value: unknown, s: Dict): string {
  return diagnosticRaw(value, s, { boolean: "raw" });
}

function percentile95(writers: MeWriterStatus[]): number | null {
  const values = writers
    .map((writer) => writer.rtt_ema_ms)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  return values[Math.ceil(values.length * 0.95) - 1] ?? null;
}

function writerState(writer: MeWriterStatus): WriterFilter {
  if (writer.degraded) return "degraded";
  if (writer.draining) return "draining";
  return "active";
}

function writerStateLabel(writer: MeWriterStatus, s: Dict): string {
  const state = writerState(writer);
  const v = s.details.pages.me.view;
  const labels: Record<string, string> = { active: v.active, degraded: v.degraded, draining: v.draining, ready: v.ready };
  const status = state !== "active" ? state : writer.state || "active";
  return labels[status] ?? status;
}

function stateForWriter(writer: MeWriterStatus): State {
  return writer.degraded ? "error" : writer.draining ? "warn" : "ok";
}

function signedDc(dc: number | null): string {
  if (dc === null) return "—";
  return dc < 0 ? `−${Math.abs(dc)}` : `+${dc}`;
}

function pairOrder(a: number, b: number): number {
  if (a >= 100 && b < 100) return 1;
  if (b >= 100 && a < 100) return -1;
  return a - b;
}

function dcPairs(quality: RuntimeMeQuality | undefined, writers: MeWriterStatus[]): DcPairPoint[] {
  const points: DcRoutePoint[] = quality
    ? quality.dc_rtt.map((row) => ({
        dc: row.dc,
        rtt: row.rtt_ema_ms,
        writers: row.alive_writers,
        required: row.required_writers,
        coverage: row.coverage_pct,
      }))
    : [
        ...writers.reduce((groups, writer) => {
          const current = groups.get(writer.dc ?? 0) ?? { count: 0, rttTotal: 0, rttCount: 0 };
          current.count += 1;
          if (writer.rtt_ema_ms !== null && Number.isFinite(writer.rtt_ema_ms)) {
            current.rttTotal += writer.rtt_ema_ms;
            current.rttCount += 1;
          }
          groups.set(writer.dc ?? 0, current);
          return groups;
        }, new Map<number, { count: number; rttTotal: number; rttCount: number }>()),
      ].map(([dc, row]) => ({
        dc,
        rtt: row.rttCount > 0 ? row.rttTotal / row.rttCount : null,
        writers: row.count,
        required: null,
        coverage: null,
      }));

  const pairs = new Map<number, DcPairPoint>();
  for (const point of points) {
    const id = Math.abs(point.dc);
    const pair = pairs.get(id) ?? { id };
    if (point.dc < 0) pair.media = point;
    else pair.rpc = point;
    pairs.set(id, pair);
  }
  return [...pairs.values()].sort((a, b) => pairOrder(a.id, b.id));
}

function RouteHero({
  mode,
  writers,
  gates,
  s,
}: {
  mode: MeRouteMode;
  writers: MeWritersData | null;
  gates: RuntimeGates | null;
  s: Dict;
}) {
  const v = s.details.pages.me.view;
  const rows = writers?.writers ?? [];
  const summary = writers?.summary;
  const boundClients = rows.reduce((total, writer) => total + writer.bound_clients, 0);
  const rtt = percentile95(rows);
  const reserve = summary ? summary.alive_writers - summary.required_writers : null;
  const modeTitle =
    mode === "middle" ? v.modeMiddle : mode === "fallback" ? v.modeFallback : mode==='direct'?v.modeDirect:s.pulse.meAvailability.unknown;
  const description =
    mode === "middle"
      ? v.modeMiddleDescription
      : mode === "fallback"
        ? v.modeFallbackDescription
        : mode==='direct'?v.modeDirectDescription:s.pulse.meAvailability.unavailableNote;
  const mark = mode === "middle" ? "ME" : mode==='unknown'?'?':"D";

  return (
    <section
      className="grid border-b border-border lg:grid-cols-[minmax(330px,1.35fr)_repeat(4,minmax(0,0.65fr))]"
      data-testid="me-route-hero"
    >
      <div className="col-span-2 flex min-w-0 items-center gap-4 border-b border-border px-4 py-5 sm:px-5 lg:col-span-1 lg:border-b-0 lg:border-r">
        <span
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-xl border font-bold",
            mode === "middle"
              ? "border-ok/35 bg-ok/15 text-ok"
              : mode === "fallback"
                ? "border-warn/35 bg-warn/15 text-warn"
                : "border-accent/35 bg-accent/15 text-accent",
          )}
        >
          {mark}
        </span>
        <div className="min-w-0">
          <p className="text-label uppercase tracking-[0.12em] text-text-muted">{v.routeKicker}</p>
          <h2 className="mt-0.5 text-h2 font-semibold text-text">{modeTitle}</h2>
          <p className="mt-1 text-micro leading-relaxed text-text-muted">{description}</p>
          <p
            className={cn(
              "mt-1.5 text-micro font-semibold",
              mode === "middle" ? "text-ok" : mode === "fallback" ? "text-warn" : "text-accent",
            )}
          >
            {mode === "fallback" && gates?.reroute_reason
              ? `reroute_active · ${gates.reroute_reason}`
              : `route_mode: ${gates?.route_mode ?? '—'}`}
          </p>
        </div>
      </div>

      <div className="min-w-0 border-b border-r border-border px-4 py-4 lg:border-b-0">
        <p className="text-micro text-text-muted">{v.writers}</p>
        <strong className="mt-1 block text-[1.65rem] font-bold leading-none tabular-nums text-text">
          {summary ? formatNumber(s, summary.alive_writers) : "—"}
        </strong>
        <p className="mt-1 text-[11.5px] leading-tight text-text-muted">
          {summary
            ? `${formatNumber(s, summary.required_writers)} ${v.requiredReserve} ${reserve !== null && reserve > 0 ? "+" : ""}${formatNumber(s, reserve ?? 0)}`
            : v.noPoolData}
        </p>
      </div>
      <div className="min-w-0 border-b border-border px-4 py-4 sm:border-r lg:border-b-0">
        <p className="text-micro text-text-muted">{v.coverage}</p>
        <strong className="mt-1 block text-[1.65rem] font-bold leading-none tabular-nums text-text">
          {formatPercent(summary?.coverage_pct, s)}
        </strong>
        <p className="mt-1 text-[11.5px] leading-tight text-text-muted">
          {summary
            ? `${formatNumber(s, summary.available_endpoints)}/${formatNumber(s, summary.configured_endpoints)} ${v.endpointsAvailable}`
            : v.noPoolData}
        </p>
      </div>
      <div className="min-w-0 border-r border-border px-4 py-4">
        <p className="text-micro text-text-muted">{v.boundClients}</p>
        <strong className="mt-1 block text-[1.65rem] font-bold leading-none tabular-nums text-text">
          {writers ? formatNumber(s, boundClients) : "—"}
        </strong>
        <p className="mt-1 text-[11.5px] leading-tight text-text-muted">{v.distributed}</p>
      </div>
      <div className="min-w-0 px-4 py-4">
        <p className="text-micro text-text-muted">{v.rttP95}</p>
        <strong
          className={cn(
            "mt-1 block text-[1.65rem] font-bold leading-none tabular-nums",
            (rtt ?? 0) > 250 ? "text-warn" : "text-text",
          )}
        >
          {formatRtt(rtt, s)}
        </strong>
        <p className="mt-1 text-[11.5px] leading-tight text-text-muted">{v.activeWriters}</p>
      </div>
    </section>
  );
}

function DcTopology({ pairs, s }: { pairs: DcPairPoint[]; s: Dict }) {
  const v = s.details.pages.me.view;
  const total = pairs.reduce(
    (sum, pair) => sum + (pair.rpc?.writers ?? 0) + (pair.media?.writers ?? 0),
    0,
  );

  return (
    <section className="min-w-0 px-4 py-5 sm:px-5" data-testid="me-topology">
      <SectionHeading level={2} variant="compact" kicker={v.topology} title={v.writersByPairs} meta={v.rttEma} />
      <div className="mt-5 grid gap-4">
        {pairs.map((pair) => {
          const rpcWriters = pair.rpc?.writers ?? 0;
          const mediaWriters = pair.media?.writers ?? 0;
          const pairTotal = Math.max(1, rpcWriters + mediaWriters);
          return (
            <div
              key={pair.id}
              className="grid grid-cols-[58px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 sm:grid-cols-[58px_minmax(120px,1fr)_132px]"
              data-me-pair={pair.id}
            >
              <div>
                <strong className="block text-meta text-text">DC {pair.id}</strong>
                <span className="text-micro text-text-muted">
                  {formatNumber(s, rpcWriters + mediaWriters)} writers
                </span>
              </div>
              <div className="flex h-3 overflow-hidden rounded bg-surface-3">
                <i
                  className="bg-[#58aee8]"
                  style={{ width: `${(rpcWriters / pairTotal) * 100}%` }}
                />
                <i
                  className="bg-[#9c7fe8]"
                  style={{ width: `${(mediaWriters / pairTotal) * 100}%` }}
                />
              </div>
              <div className="col-start-2 flex items-center justify-between gap-3 text-micro tabular-nums sm:col-start-3">
                <span className={cn((pair.rpc?.rtt ?? 0) >= 250 ? "text-warn" : "text-text")}>
                  <strong>{formatRtt(pair.rpc?.rtt, s).replace(` ${v.ms}`, "")}</strong>{" "}
                  <span className="text-text-muted">RPC</span>
                </span>
                <span className={cn((pair.media?.rtt ?? 0) >= 250 ? "text-warn" : "text-text")}>
                  <strong>{formatRtt(pair.media?.rtt, s).replace(` ${v.ms}`, "")}</strong>{" "}
                  <span className="text-text-muted">Media</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <footer className="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-micro text-text-muted">
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#58aee8]" />
          RPC +N
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#9c7fe8]" />
          Media −N
        </span>
        <span>
          <strong className="text-text">{formatNumber(s, total)}</strong> {v.totalWriters}
        </span>
      </footer>
    </section>
  );
}

function RouteReadiness({
  mode,
  gates,
  writers,
  quality,
  degraded,
  s,
}: {
  mode: MeRouteMode;
  gates: RuntimeGates | null;
  writers: MeWritersData | null;
  quality: RuntimeMeQuality | undefined;
  degraded: number;
  s: Dict;
}) {
  const v = s.details.pages.me.view;
  const summary = writers?.summary;
  const drainOpen = quality?.drain_gate.route_quorum_ok && quality.drain_gate.redundancy_ok;
  const modeLabel =
    mode === "middle" ? v.modeMiddle : mode === "fallback" ? v.modeFallback : mode==='direct'?v.modeDirect:s.pulse.meAvailability.unknown;
  const note =
    mode === "middle" ? v.reserveNote : mode === "fallback" ? v.fallbackNote : mode==='direct'?v.directNote:s.pulse.meAvailability.unavailableNote;
  const rows = [
    [v.newSessions, v.routeMode, modeLabel, mode === "fallback" ? "warn" : mode==='unknown'?'muted':"ok"],
    [
      v.meRuntime,
      v.ready,
      gates ? (gates.me_runtime_ready ? v.ready : v.notReady) : '—',
      gates ? (gates.me_runtime_ready ? "ok" : "warn") : 'muted',
    ],
    [
      v.degradedWriters,
      v.noCoverageEffect,
      writers ? formatNumber(s, degraded) : "—",
      degraded > 0 ? "warn" : "ok",
    ],
    [
      v.endpoints,
      v.temporaryUnavailable,
      summary
        ? `${formatNumber(s, summary.available_endpoints)}/${formatNumber(s, summary.configured_endpoints)}`
        : "—",
      "ok",
    ],
    [
      v.drainGate,
      v.quorumAndRedundancy,
      quality ? (drainOpen ? v.open : v.blocked) : "—",
      drainOpen ? "ok" : "warn",
    ],
  ] as const;

  return (
    <section
      className="min-w-0 border-t border-border px-4 py-5 sm:px-5 lg:border-l lg:border-t-0"
      data-testid="me-readiness"
    >
      <SectionHeading level={2} variant="compact" kicker={v.controller} title={v.routeReadiness} />
      <div className="mt-4 overflow-hidden rounded-xl border border-border">
        {rows.map(([label, detail, value, tone]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-4 border-b border-border px-3 py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <span className="block text-meta text-text-muted">{label}</span>
              <small className="block text-micro text-text-faint">{detail}</small>
            </div>
            <strong className={cn("shrink-0 text-meta", tone === "warn" ? "text-warn" : tone==='ok'?"text-ok":"text-text-muted")}>
              {value}
            </strong>
          </div>
        ))}
      </div>
      <p className="mt-4 flex gap-2 text-micro leading-relaxed text-text-muted">
        <span className="text-accent">i</span>
        {note}
      </p>
    </section>
  );
}

function PoolComposition({
  pool,
  writers,
  s,
}: {
  pool: RuntimeMePoolState | undefined;
  writers: MeWritersData | null;
  s: Dict;
}) {
  const v = s.details.pages.me.view;
  const total = pool?.writers.total ?? writers?.writers.length ?? 0;
  const degraded =
    pool?.writers.health.degraded ??
    writers?.writers.filter((writer) => writer.degraded).length ??
    0;
  const draining =
    pool?.writers.health.draining ??
    writers?.writers.filter((writer) => writer.draining).length ??
    0;
  const healthy = Math.max(
    0,
    (pool?.writers.health.healthy ?? total) - (pool ? 0 : degraded + draining),
  );
  const denominator = Math.max(1, healthy + degraded + draining);

  return (
    <section
      className="grid items-center gap-4 border-t border-border px-4 py-4 sm:grid-cols-[110px_minmax(0,1fr)_auto] sm:px-5"
      data-testid="me-composition"
    >
      <div>
        <span className="text-micro text-text-muted">{v.activeGeneration}</span>
        <strong className="block text-h2 font-semibold tabular-nums text-text">
          {pool ? `#${formatNumber(s, pool.generations.active_generation)}` : "—"}
        </strong>
      </div>
      {total > 0 ? (
        <div className="flex h-2 overflow-hidden rounded-full bg-surface-3">
          <i className="bg-ok" style={{ width: `${(healthy / denominator) * 100}%` }} />
          <i className="bg-warn" style={{ width: `${(degraded / denominator) * 100}%` }} />
          <i className="bg-accent" style={{ width: `${(draining / denominator) * 100}%` }} />
        </div>
      ) : (
        <p className="text-meta text-text-muted">{v.noPoolData}</p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-micro text-text-muted">
        <span>
          <strong className="text-text">{formatNumber(s, healthy)}</strong> {v.healthy}
        </span>
        <span>
          <strong className={degraded > 0 ? "text-warn" : "text-text"}>
            {formatNumber(s, degraded)}
          </strong>{" "}
          {v.degraded}
        </span>
        <span>
          <strong className="text-text">{formatNumber(s, draining)}</strong> {v.draining}
        </span>
      </div>
    </section>
  );
}

function OverviewPanel({
  mode,
  gates,
  writers,
  pool,
  quality,
  s,
}: {
  mode: MeRouteMode;
  gates: RuntimeGates | null;
  writers: MeWritersData | null;
  pool: RuntimeMePoolState | undefined;
  quality: RuntimeMeQuality | undefined;
  s: Dict;
}) {
  const rows = writers?.writers ?? [];
  const pairs = dcPairs(quality, rows);
  const degraded = rows.filter((writer) => writer.degraded).length;
  return (
    <div data-testid="me-overview">
      <div className="grid border-b border-border lg:grid-cols-[minmax(0,1.65fr)_minmax(310px,0.75fr)]">
        <DcTopology pairs={pairs} s={s} />
        <RouteReadiness
          mode={mode}
          gates={gates}
          writers={writers}
          quality={quality}
          degraded={degraded}
          s={s}
        />
      </div>
      <PoolComposition pool={pool} writers={writers} s={s} />
    </div>
  );
}

function WritersPanel({ writers, s }: { writers: MeWriterStatus[]; s: Dict }) {
  const v = s.details.pages.me.view;
  const [filter, setFilter] = useState<WriterFilter>("all");
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(12);
  const counts = {
    all: writers.length,
    active: writers.filter((writer) => writerState(writer) === "active").length,
    degraded: writers.filter((writer) => writerState(writer) === "degraded").length,
    draining: writers.filter((writer) => writerState(writer) === "draining").length,
  };
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return writers.filter((writer) => {
      if (filter !== "all" && writerState(writer) !== filter) return false;
      if (!needle) return true;
      return `${writer.writer_id} ${writer.dc ?? ""} ${writer.endpoint} ${writer.state}`
        .toLowerCase()
        .includes(needle);
    });
  }, [filter, query, writers]);
  const visible = filtered.slice(0, visibleLimit);

  const filters: Array<[WriterFilter, string]> = [
    ["all", v.all],
    ["degraded", s.details.pages.me.filterDegraded],
    ["draining", s.details.pages.me.filterDraining],
    ["active", v.active],
  ];

  return (
    <section className="px-4 py-5 sm:px-5" data-testid="me-writers">
      <SectionHeading level={2} variant="compact"
        kicker={v.pointDiagnostics}
        title={v.writersAndClients}
        meta={`${formatNumber(s, writers.length)} ${v.total}`}
      />
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex gap-1 overflow-x-auto"
          role="group"
          aria-label={s.details.pages.me.filterState}
        >
          {filters.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => {
                setFilter(id);
                setVisibleLimit(12);
              }}
              className={cn(
                "shrink-0 rounded-lg border px-3 py-2 text-micro font-semibold",
                filter === id
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border bg-surface-2 text-text-muted",
              )}
            >
              {label} · {formatNumber(s, counts[id])}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setVisibleLimit(12);
          }}
          placeholder={v.searchPlaceholder}
          aria-label={v.searchPlaceholder}
          className="h-10 w-full rounded-lg border border-border bg-surface-2 px-3 text-meta text-text outline-none placeholder:text-text-faint focus:border-accent sm:max-w-64"
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-border">
        <div className="hidden grid-cols-[100px_90px_minmax(180px,1fr)_90px_90px_92px] gap-3 bg-surface-2 px-3 py-2 text-micro text-text-muted md:grid">
          <span>{v.writer}</span>
          <span>{v.route}</span>
          <span>{v.endpoint}</span>
          <span>{v.clients}</span>
          <span>RTT EMA</span>
          <span>{v.state}</span>
        </div>
        {visible.map((writer) => (
          <details
            key={writer.writer_id}
            className="group border-t border-border first:border-t-0 md:first:border-t"
            data-writer-state={writerState(writer)}
          >
            <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] gap-x-3 gap-y-2 px-3 py-3 hover:bg-surface-2 md:grid-cols-[100px_90px_minmax(180px,1fr)_90px_90px_92px] md:items-center">
              <strong className="text-meta tabular-nums text-text">#{writer.writer_id}</strong>
              <span
                className={cn(
                  "justify-self-end rounded px-1.5 py-0.5 text-micro font-semibold md:justify-self-start",
                  writer.dc !== null && writer.dc < 0
                    ? "bg-[#9c7fe8]/15 text-[#b9a5f2]"
                    : "bg-[#58aee8]/15 text-[#7dc5f3]",
                )}
              >
                {writer.dc !== null && writer.dc < 0 ? "Media" : "RPC"} {signedDc(writer.dc)}
              </span>
              <code
                className="col-span-2 min-w-0 truncate font-mono text-micro text-text-muted md:col-span-1"
                title={writer.endpoint}
              >
                {writer.endpoint}
              </code>
              <span className="text-meta tabular-nums text-text">
                <small className="mr-1 text-text-muted md:hidden">{v.clients}</small>
                {formatNumber(s, writer.bound_clients)}
              </span>
              <span className="justify-self-end text-meta tabular-nums text-text md:justify-self-start">
                {formatRtt(writer.rtt_ema_ms, s)}
              </span>
              <span className="col-span-2 justify-self-start md:col-span-1">
                <StatePill state={stateForWriter(writer)}>{writerStateLabel(writer, s)}</StatePill>
              </span>
            </summary>
            <dl className="grid border-t border-border bg-surface-2 px-3 py-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                [v.generation, formatNumber(s, writer.generation)],
                [
                  v.idle,
                  writer.idle_for_secs === null
                    ? "—"
                    : `${formatNumber(s, writer.idle_for_secs)} ${v.secondsShort}`,
                ],
                [v.desiredMap, writer.in_desired_map ? v.yes : v.no],
                [v.activeGenerationMatch, writer.matches_active_generation ? v.yes : v.no],
                [v.drainFallback, writer.allow_drain_fallback ? v.yes : v.no],
                ["drain_started_at", formatRaw(writer.drain_started_at_epoch_secs, s)],
                ["drain_deadline", formatRaw(writer.drain_deadline_epoch_secs, s)],
                ["drain_over_ttl", writer.drain_over_ttl ? v.yes : v.no],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0 border-b border-border px-2 py-2">
                  <dt className="font-mono text-micro text-text-muted">{label}</dt>
                  <dd className="mt-0.5 break-all text-meta font-semibold text-text">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
        {filtered.length === 0 && (
          <p className="px-4 py-10 text-center text-meta text-text-muted">{v.noWriters}</p>
        )}
        {visible.length < filtered.length && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-2 px-3 py-3">
            <span className="text-micro text-text-muted">
              {s.details.collection.shownTemplate
                .replace("{shown}", formatNumber(s, visible.length))
                .replace("{total}", formatNumber(s, filtered.length))}
            </span>
            <button
              type="button"
              onClick={() => setVisibleLimit((current) => current + 12)}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-meta font-semibold text-text hover:border-accent hover:text-accent"
            >
              {s.details.collection.showMore}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function RttChart({ rows, s }: { rows: RuntimeMeQualityDcRtt[]; s: Dict }) {
  const v = s.details.pages.me.view;
  const pairs = dcPairs({ dc_rtt: rows } as RuntimeMeQuality, []);
  const values = rows
    .map((row) => row.rtt_ema_ms)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const maximum = Math.ceil(Math.max(200, ...values, 1) / 50) * 50;

  return (
    <div className="mt-5" data-testid="me-rtt-chart">
      <div className="relative h-64 pl-9">
        {[maximum, maximum / 2, 0].map((tick, index) => (
          <div
            key={tick}
            className="absolute left-0 right-0 flex items-center"
            style={{ top: `${index * 50}%` }}
          >
            <span className="w-8 -translate-y-1/2 text-right text-[10px] tabular-nums text-text-faint">
              {formatNumber(s, tick)}
            </span>
            <i className="ml-1 h-px flex-1 bg-border" />
          </div>
        ))}
        <div className="absolute inset-y-0 left-10 right-0 grid grid-cols-6 items-end gap-1 sm:gap-3">
          {pairs.map((pair) => (
            <div key={pair.id} className="flex h-full min-w-0 flex-col justify-end">
              <div className="flex min-h-0 flex-1 items-end justify-center gap-0.5 sm:gap-1">
                {[pair.rpc, pair.media].map((route, index) => {
                  const height =
                    route?.rtt === null || route?.rtt === undefined
                      ? 0
                      : Math.max(3, (route.rtt / maximum) * 100);
                  return (
                    <div
                      key={index}
                      className="flex h-full min-w-0 flex-1 items-end justify-center"
                    >
                      <i
                        data-rtt-bar={route?.dc ?? "missing"}
                        className={cn(
                          "relative block w-full max-w-7 rounded-t",
                          index === 0 ? "bg-[#58aee8]" : "bg-[#9c7fe8]",
                          (route?.rtt ?? 0) >= 250 && "bg-warn",
                        )}
                        style={{ height: `${Math.min(100, height)}%` }}
                      >
                        {route?.rtt !== null && route?.rtt !== undefined && (
                          <b className="absolute -top-4 left-1/2 -translate-x-1/2 text-[10px] font-semibold tabular-nums text-text">
                            {formatNumber(s, Math.round(route.rtt))}
                          </b>
                        )}
                      </i>
                    </div>
                  );
                })}
              </div>
              <span className="mt-2 text-center text-[10px] font-semibold text-text-muted">
                DC {pair.id}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="ml-9 mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-micro text-text-muted">
        <span>
          <b className="text-[#58aee8]">RPC</b> +N
        </span>
        <span>
          <b className="text-[#9c7fe8]">Media</b> −N
        </span>
        <span>{v.rttEma}</span>
      </div>
    </div>
  );
}

function QualityPanel({
  quality,
  selftest,
  writers,
  s,
}: {
  quality: RuntimeMeQuality | undefined;
  selftest: RuntimeMeSelftest | undefined;
  writers: MeWriterStatus[];
  s: Dict;
}) {
  const v = s.details.pages.me.view;
  if (!quality)
    return (
      <p className="px-5 py-12 text-center text-meta text-text-muted">{v.sourceUnavailable}</p>
    );
  const familiesHealthy = quality.family_states.every(
    (row) => row.state.toLowerCase() === "healthy",
  );
  const drainOpen = quality.drain_gate.route_quorum_ok && quality.drain_gate.redundancy_ok;
  const queue = quality.route_drops.queue_full_total;
  const kdf = selftest?.kdf;
  const p95 = percentile95(writers);
  const signals = [
    [
      v.addressFamilies,
      quality.family_states.map((row) => `${row.family} ${row.state}`).join(" · "),
      `${v.failStreak} ${Math.max(0, ...quality.family_states.map((row) => row.fail_streak))}`,
      familiesHealthy ? "ok" : "warn",
    ],
    [
      v.drainGate,
      drainOpen ? v.open : v.blocked,
      quality.drain_gate.block_reason,
      drainOpen ? "ok" : "warn",
    ],
    [
      v.queueFull,
      formatNumber(s, queue),
      `base ${formatNumber(s, quality.route_drops.queue_full_base_total)} · high ${formatNumber(s, quality.route_drops.queue_full_high_total)}`,
      queue === 0 ? "ok" : "warn",
    ],
    [
      v.kdfDrift,
      kdf ? `${formatNumber(s, kdf.ewma_errors_per_min)} ${s.details.value.perMinute}` : "—",
      kdf ? `${v.threshold} ${formatNumber(s, kdf.threshold_errors_per_min)}` : "—",
      kdf && kdf.ewma_errors_per_min > kdf.threshold_errors_per_min ? "warn" : "ok",
    ],
  ] as const;
  const counters = [
    [v.reconnectAttempts, quality.counters.reconnect_attempt_total, "attempts"],
    [v.reconnectSuccess, quality.counters.reconnect_success_total, "success"],
    [v.noConnection, quality.route_drops.no_conn_total, "route drops"],
    [v.channelClosed, quality.route_drops.channel_closed_total, "route drops"],
    [
      v.peerIdleEof,
      quality.counters.idle_close_by_peer_total + quality.counters.reader_eof_total,
      "combined",
    ],
  ] as const;

  return (
    <div
      className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(310px,0.8fr)]"
      data-testid="me-quality"
    >
      <section className="min-w-0 border-b border-border px-4 py-5 sm:px-5 lg:border-b-0 lg:border-r">
        <SectionHeading level={2} variant="compact"
          kicker={v.latency}
          title={v.rttByPairs}
          meta={`${v.lowerIsBetter} · p95 ${formatRtt(p95, s)}`}
        />
        <RttChart rows={quality.dc_rtt} s={s} />
      </section>
      <section className="min-w-0 border-b border-border px-4 py-5 sm:px-5 lg:border-b-0">
        <SectionHeading level={2} variant="compact" kicker={v.currentSignals} title={v.safeToUse} />
        <div className="mt-4 overflow-hidden rounded-xl border border-border">
          {signals.map(([label, value, detail, tone]) => (
            <div key={label} className="border-b border-border px-3 py-3 last:border-b-0">
              <div className="flex items-center justify-between gap-3">
                <span className="text-meta text-text-muted">{label}</span>
                <strong className={tone === "warn" ? "text-warn" : "text-ok"}>{value}</strong>
              </div>
              <small className="mt-0.5 block text-micro text-text-faint">{detail}</small>
            </div>
          ))}
        </div>
      </section>
      <section
        className="border-t border-border px-4 py-5 sm:px-5 lg:col-span-2"
        data-testid="me-quality-counters"
      >
        <SectionHeading level={2} variant="compact"
          kicker={v.lifetime}
          title={v.investigationCounters}
          meta={v.cumulativeNotHealth}
        />
        <div className="mt-4 grid overflow-hidden rounded-xl border border-border sm:grid-cols-2 lg:grid-cols-5">
          {counters.map(([label, value, detail]) => (
            <div key={label} className="border-b border-r border-border px-3 py-3 last:border-r-0">
              <span className="text-micro text-text-muted">{label}</span>
              <strong className="mt-1 block text-h3 tabular-nums text-text">
                {formatNumber(s, value)}
              </strong>
              <small className="text-micro text-text-faint">{detail}</small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function MePage() {
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const navigate = useNavigate();
  const s = useStrings();
  const nowMs = useNow(1_000);
  const [tab, setTab] = useState<MeTab>("overview");

  const meWriters = upstreams.data?.me_writers ?? null;
  const poolGate = runtime.data ? resolveGated(runtime.data.me_pool_state) : null;
  const qualityGate = runtime.data ? resolveGated(runtime.data.me_quality) : null;
  const selftestGate = runtime.data ? resolveGated(runtime.data.me_selftest) : null;
  const minimalGate = runtime.data ? resolveGated(runtime.data.minimal) : null;
  const pool = poolGate?.status === "ok" ? poolGate.data : undefined;
  const quality = qualityGate?.status === "ok" ? qualityGate.data : undefined;
  const selftest = selftestGate?.status === "ok" ? selftestGate.data : undefined;
  const runtimeSettings = minimalGate?.status === "ok" ? minimalGate.data.me_runtime : undefined;
  const gates = !runtime.stale&&!runtime.error ? runtime.data?.gates ?? null : null;
  const initialization = runtime.data?.initialization ?? null;
  const mode = runtime.stale||runtime.error?'unknown':meRouteMode(gates,gates?meWriters:null);
  const availability=meAvailability(runtime,!!pool, runtime.data?.me_pool_state?.reason);
  const notice=availability==='direct'||runtime.data||runtime.error?availability:null;

  const payload = mePagePayload({
    meWriters,
    gates,
    initialization,
    pool,
    quality,
    selftest,
    meRuntime: runtimeSettings,
  });

  const inputs: Record<string, DetailSourceInput> = {
    upstreams: {
      kind: "topic",
      snapshot: upstreams,
      ...(meWriters
        ? {
            gated: {
              enabled: meWriters.middle_proxy_enabled,
              ...(meWriters.reason !== undefined ? { reason: meWriters.reason } : {}),
              data: meWriters.writers,
            },
          }
        : {}),
      generatedAt: meWriters?.generated_at_epoch_secs ?? null,
    },
    runtime: { kind: "topic", snapshot: runtime },
    runtime_edge: { kind: "topic", snapshot: runtime, gated: runtime.data?.me_pool_state ?? null },
    minimal: { kind: "topic", snapshot: runtime, gated: runtime.data?.minimal ?? null },
  };
  const sources = useDetailSources(meSources, inputs);
  const v = s.details.pages.me.view;
  const tabs: Array<[MeTab, string, number | null]> = [
    ["overview", s.details.pages.me.tabs.overview, null],
    ["writers", s.details.pages.me.tabs.writers, meWriters?.writers.length ?? null],
    ["quality", s.details.pages.me.tabs.quality, null],
    ["initialization", s.details.pages.me.tabs.initialization, null],
    ["runtime", s.details.pages.me.tabs.runtime, null],
  ];
  const technical = [
    ["middle_proxy_enabled", meWriters ? formatRaw(meWriters.middle_proxy_enabled, s) : "—"],
    ["route_mode", gates?.route_mode ?? "—"],
    [
      "configured_dc_groups",
      meWriters ? formatNumber(s, meWriters.summary.configured_dc_groups) : "—",
    ],
    ["available_pct", formatPercent(meWriters?.summary.available_pct, s)],
    ["required_writers", meWriters ? formatNumber(s, meWriters.summary.required_writers) : "—"],
    [
      "fresh_alive_writers",
      meWriters ? formatNumber(s, meWriters.summary.fresh_alive_writers) : "—",
    ],
    ["reason", meWriters?.reason ?? "—"],
    [
      "generated_at_epoch_secs",
      meWriters ? formatNumber(s, meWriters.generated_at_epoch_secs) : "—",
    ],
  ];

  return (
    <div className="w-full" data-testid="me-detail">
      <DetailHeader
        title={s.details.pages.me.title}
        description={s.details.pages.me.description}
        status={notice==='direct'?'empty':notice==='fallback'?'partial':sources.status}
        statusLabel={notice?meAvailabilityText(notice,s).label:undefined}
        freshnessMs={sources.freshnessMs}
        nowMs={nowMs}
        onBack={() => void navigate({ to: "/pulse" })}
      />
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">

        {payload === null ? (
          <div className="grid min-h-64 place-items-center px-5 text-center">
            <div>
              <p className="text-h3 font-semibold text-text">
                {upstreams.error || runtime.error ? v.sourceUnavailable : v.loading}
              </p>
              <p className="mt-1 text-meta text-text-muted">
                {upstreams.error ?? runtime.error ?? v.loadingDescription}
              </p>
            </div>
          </div>
        ) : (
          <>
            {notice?<div className="border-b border-border px-4 py-5 sm:px-5"><MeSourceNotice state={notice} available={!!pool}/></div>:<RouteHero mode={mode} writers={meWriters} gates={gates} s={s} />}
            {notice!=='direct'&&<>
            <div
              className="border-b border-border px-3 pt-2"
              role="tablist"
              aria-label={s.details.pages.me.title}
              data-testid="me-tabs"
            >
              <div className="flex gap-1 overflow-x-auto">
                {tabs.map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    className={cn(
                      "shrink-0 rounded-t-lg px-3 py-2.5 text-micro font-semibold",
                      tab === id ? "bg-accent/18 text-accent" : "text-text-muted hover:text-text",
                    )}
                  >
                    {label}
                    {count !== null && (
                      <b className="ml-1 font-semibold tabular-nums">{formatNumber(s, count)}</b>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div role="tabpanel">
              {tab === "overview" && (
                <OverviewPanel
                  mode={mode}
                  gates={gates}
                  writers={meWriters}
                  pool={pool}
                  quality={quality}
                  s={s}
                />
              )}
              {tab === "writers" && <WritersPanel writers={meWriters?.writers ?? []} s={s} />}
              {tab === "quality" && (
                <QualityPanel
                  quality={quality}
                  selftest={selftest}
                  writers={meWriters?.writers ?? []}
                  s={s}
                />
              )}
              {tab === "initialization" && (
                <InitializationPanel initialization={initialization} nowMs={nowMs} s={s} />
              )}
              {tab === "runtime" && (
                <RuntimePanel
                  gates={gates}
                  pool={pool}
                  quality={quality}
                  selftest={selftest}
                  runtimeSettings={runtimeSettings}
                  s={s}
                />
              )}
            </div>

            </>}
            <TechnicalSection title={v.technical} data-testid="me-technical">
              <dl className="mt-4 grid border-t border-border sm:grid-cols-2 xl:grid-cols-4">
                {technical.map(([label, value]) => (
                  <div key={label} className="min-w-0 border-b border-r border-border px-3 py-3">
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
