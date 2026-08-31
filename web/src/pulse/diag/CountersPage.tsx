import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useDisplayMode } from "../../display-mode";
import { fill, formatNumber, useStrings, type Dict } from "../../i18n";
import { getTelemtZeroOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { ZeroAllData } from "../../lib/api/generated/types.gen";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { formatDurationApprox } from "../../people/expiry";
import { useNow } from "../../people/useNow";
import { DetailHeader } from "../details-builder/DetailHeader";
import {
  COUNTER_GROUP_PATHS,
  counterLeaves,
  countersPageDefinition,
  isFailureCounterPath,
  type CounterGroupPath,
} from "../details-builder/definitions/counters";
import { describeField } from "../details-builder/fieldCatalog";
import { formatValue } from "../details-builder/formatting";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import {
  computeCounterDeltas,
  countersRefetchInterval,
  countersRestarted,
  type CounterSnapshot,
} from "./counters.helpers";
import {
  breakdownRows,
  counterViewMetrics,
  readCounterViewValues,
  scalarCounterRows,
  type BreakdownRow,
  type CounterViewMetrics,
} from "./counters.view.helpers";

type CountersTab = "activity" | "failures" | "explorer";
type CounterFilter = "all" | "nonzero" | "errors";

interface Reading {
  values: CounterSnapshot;
  atMs: number;
}

interface DeltaState {
  atMs: number;
  current: Reading | null;
  previous: Reading | null;
  baseline: Reading | null;
  token: number;
  restarted: boolean;
}

const EMPTY: DeltaState = {
  atMs: 0,
  current: null,
  previous: null,
  baseline: null,
  token: 0,
  restarted: false,
};

function useCounterDeltas(data: ZeroAllData | undefined, dataUpdatedAt: number) {
  const [state, setState] = useState(EMPTY);
  const [resetToken, setResetToken] = useState(0);
  let next = state;
  if (data && dataUpdatedAt > 0 && dataUpdatedAt !== state.atMs) {
    const reading = { values: readCounterViewValues(data), atMs: dataUpdatedAt };
    const restarted = state.current !== null && countersRestarted(state.current.values, reading.values);
    next = {
      atMs: dataUpdatedAt,
      current: reading,
      previous: restarted ? null : state.current,
      baseline: restarted ? reading : (state.baseline ?? reading),
      token: resetToken,
      restarted: state.restarted || restarted,
    };
  }
  if (next.token !== resetToken && next.current !== null) {
    next = { ...next, baseline: next.current, token: resetToken, restarted: false };
  }
  if (next !== state) setState(next);

  const reset = useCallback(() => setResetToken((value) => value + 1), []);
  if (next.current === null) {
    return {
      perSecond: undefined,
      window: undefined,
      sinceOpen: undefined,
      windowSeconds: null,
      restarted: false,
      reset,
    };
  }
  const deltas = computeCounterDeltas({
    previous: next.previous,
    baseline: next.baseline,
    current: next.current,
  });
  return {
    perSecond: next.previous ? deltas.perSecond : undefined,
    window: next.previous ? deltas.sincePrevious : undefined,
    sinceOpen: next.baseline === next.current ? undefined : deltas.sinceOpen,
    windowSeconds: next.previous ? Math.max(0, (next.current.atMs - next.previous.atMs) / 1000) : null,
    restarted: next.restarted,
    reset,
  };
}

function signed(s: Dict, value: number | null): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${formatNumber(s, Math.round(value * 100) / 100)}`;
}

function numberAt(data: ZeroAllData, path: string): number | null {
  const [group, key] = path.split(".") as [CounterGroupPath, string];
  const value = data[group]?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ratio(part: number | null, total: number | null): number | null {
  if (part === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

function percent(s: Dict, value: number | null): string {
  return value === null ? "—" : `${formatNumber(s, Math.round(value * 10) / 10)}%`;
}

function windowLabel(s: Dict, seconds: number | null): string {
  return seconds === null ? s.details.pages.counters.view.nextSnapshot : fill(s.details.pages.counters.view.secondsWindow, { count: formatNumber(s, Math.max(1, Math.round(seconds))) });
}

function SectionHead({ kicker, title, meta }: { kicker: string; title: string; meta?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <span className="text-micro font-semibold uppercase tracking-[0.16em] text-text-faint">{kicker}</span>
        <h2 className="mt-1 text-h2 font-semibold text-text">{title}</h2>
      </div>
      {meta && <span className="text-meta text-text-muted">{meta}</span>}
    </header>
  );
}

function CountersHero({ metrics, windowSeconds, restarted }: { metrics: CounterViewMetrics; windowSeconds: number | null; restarted: boolean }) {
  const s = useStrings();
  const v = s.details.pages.counters.view;
  const collecting = metrics.connections === null;
  const warning = !collecting && (metrics.newFailureSignals ?? 0) > 0;
  const tone = collecting ? "info" : warning ? "warn" : "ok";
  const title = collecting ? v.collectingBaseline : warning ? v.failuresMoving : v.flowStable;
  const detail = collecting ? (restarted ? v.restartDescription : v.baselineDescription) : warning ? fill(v.failuresMovingDescription, { count: formatNumber(s, metrics.newFailureSignals ?? 0) }) : v.flowStableDescription;
  const upstream = metrics.upstreamAttempts === null ? "—" : `${formatNumber(s, metrics.upstreamSuccess ?? 0)} / ${formatNumber(s, metrics.upstreamAttempts)}`;
  const bytesRate = metrics.payloadBytes === null || windowSeconds === null || windowSeconds <= 0 ? "—" : `${formatBytes(metrics.payloadBytes / windowSeconds, s)}/${v.secondShort}`;
  return (
    <section className="grid border-y border-border bg-bg/25 xl:grid-cols-[minmax(330px,1.35fr)_repeat(4,minmax(130px,.55fr))]" data-testid="counters-hero">
      <div className={cn("flex min-h-32 items-center gap-4 border-b border-border px-4 py-5 xl:border-b-0 xl:border-r sm:px-5", tone === "warn" && "bg-warning/5", tone === "info" && "bg-accent/5")} data-counters-tone={tone}>
        <span className={cn("grid h-12 w-12 shrink-0 place-items-center rounded-xl border text-xl font-extrabold", tone === "ok" ? "border-success/35 bg-gradient-to-br from-success/30 to-success/10 text-success-text" : tone === "warn" ? "border-warning/40 bg-gradient-to-br from-warning/30 to-warning/10 text-warning-text" : "border-accent/35 bg-gradient-to-br from-accent/25 to-accent/5 text-accent")} aria-hidden="true">{tone === "ok" ? "✓" : tone === "warn" ? "!" : "↻"}</span>
        <div className="min-w-0">
          <span className="text-micro font-semibold uppercase tracking-[0.16em] text-text-faint">{v.currentWindow}</span>
          <h2 className="mt-1 text-h2 font-semibold text-text">{title}</h2>
          <p className="mt-1 text-meta leading-relaxed text-text-muted">{detail}</p>
          <small className={cn("mt-2 block text-micro font-semibold", tone === "ok" ? "text-success-text" : tone === "warn" ? "text-warning-text" : "text-accent")}>{windowLabel(s, windowSeconds)}</small>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-border xl:col-span-4 xl:grid-cols-4">
        <HeroVital label={v.newConnections} value={signed(s, metrics.connections)} hint={v.perWindow} />
        <HeroVital label={v.upstreamSuccess} value={upstream} hint={v.successAttempts} />
        <HeroVital label="D2C payload" value={bytesRate} hint={v.measuredRate} />
        <HeroVital label={v.newSignals} value={metrics.newFailureSignals === null ? "—" : formatNumber(s, metrics.newFailureSignals)} hint={v.notLifetimeSum} warn={(metrics.newFailureSignals ?? 0) > 0} />
      </div>
    </section>
  );
}

function HeroVital({ label, value, hint, warn = false }: { label: string; value: string; hint: string; warn?: boolean }) {
  return <div className={cn("min-w-0 bg-surface px-4 py-4", warn && "bg-warning/5")}><span className="block text-micro text-text-faint">{label}</span><strong className={cn("mt-1 block break-words text-lg font-bold tabular-nums text-text", warn && "text-warning-text")}>{value}</strong><small className="mt-1 block text-micro leading-snug text-text-muted">{hint}</small></div>;
}

function WindowNote({ collecting, restarted }: { collecting: boolean; restarted: boolean }) {
  const v = useStrings().details.pages.counters.view;
  return <div className={cn("mt-4 flex gap-3 rounded-xl border px-4 py-3", collecting ? "border-accent/25 bg-accent/5" : "border-border bg-bg/30")}><span className="font-bold text-accent">{collecting ? "↻" : "i"}</span><p className="text-meta leading-relaxed text-text-muted">{collecting ? restarted ? v.restartWindowNote : v.baselineWindowNote : v.measuredWindowNote}</p></div>;
}

function ActivityPanel({ data, metrics, windowSeconds, restarted }: { data: ZeroAllData; metrics: CounterViewMetrics; windowSeconds: number | null; restarted: boolean }) {
  const s = useStrings();
  const v = s.details.pages.counters.view;
  const collecting = metrics.connections === null;
  const badShare = ratio(metrics.badConnections, metrics.connections);
  const successShare = ratio(metrics.upstreamSuccess, metrics.upstreamAttempts);
  const uptime = numberAt(data, "core.uptime_seconds");
  const bytesRate = metrics.payloadBytes === null || windowSeconds === null || windowSeconds <= 0 ? null : metrics.payloadBytes / windowSeconds;
  return (
    <section className="p-4 sm:p-5" data-testid="counters-activity-panel">
      <SectionHead kicker={fill(v.twoSnapshots, { window: windowLabel(s, windowSeconds) })} title={v.currentTrafficPath} meta={v.absolutesInExplorer} />
      <WindowNote collecting={collecting} restarted={restarted} />
      <div className="mt-5 grid items-stretch gap-2 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <TrafficNode step="1" title="Core" state={collecting ? v.baseline : v.active} value={signed(s, metrics.connections)} description={v.clientConnectionsWindow} metrics={[[v.unsuccessful, signed(s, metrics.badConnections), (metrics.badConnections ?? 0) > 0], [v.failureShare, percent(s, badShare), false]]} progress={badShare === null ? null : 100 - badShare} warn={(metrics.badConnections ?? 0) > 0} />
        <span className="hidden self-center text-text-faint lg:block">→</span>
        <TrafficNode step="2" title="Upstream" state={collecting ? v.baseline : (metrics.upstreamFail ?? 0) > 0 ? v.hasFailures : v.success100} value={signed(s, metrics.upstreamAttempts)} description={v.connectAttemptsWindow} metrics={[[v.successful, signed(s, metrics.upstreamSuccess), false], [v.unsuccessful, signed(s, metrics.upstreamFail), (metrics.upstreamFail ?? 0) > 0]]} progress={successShare} warn={(metrics.upstreamFail ?? 0) > 0} />
        <span className="hidden self-center text-text-faint lg:block">→</span>
        <TrafficNode step="3" title="Middle proxy" state={collecting ? v.baseline : (bytesRate ?? 0) > 0 ? v.transmitting : v.noTraffic} value={bytesRate === null ? "—" : `${formatBytes(bytesRate, s)}/${v.secondShort}`} description={v.payloadToClients} metrics={[["Data frames", signed(s, metrics.dataFrames), false], ["Route drop", signed(s, metrics.routeDrops), (metrics.routeDrops ?? 0) > 0]]} progress={null} warn={(metrics.routeDrops ?? 0) > 0} />
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <QuietCard kicker="Pool" title={v.writers} hint={v.poolEventsHint} value={metrics.poolEvents === null ? "—" : metrics.poolEvents > 0 ? fill(v.eventsCount, { count: formatNumber(s, metrics.poolEvents) }) : v.noMovement} warn={(metrics.poolEvents ?? 0) > 0} />
        <QuietCard kicker="Desync" title={v.protocol} hint={v.desyncHint} value={signed(s, metrics.desyncEvents)} warn={(metrics.desyncEvents ?? 0) > 0} />
        <QuietCard kicker="Uptime" title={uptime === null ? "—" : formatDurationApprox(uptime * 1000, s)} hint={v.uptimeBoundary} value={restarted ? v.restarted : v.continuous} />
      </div>
    </section>
  );
}

function TrafficNode({ step, title, state, value, description, metrics, progress, warn }: { step: string; title: string; state: string; value: string; description: string; metrics: Array<[string, string, boolean]>; progress: number | null; warn: boolean }) {
  return <article className={cn("min-w-0 rounded-xl border border-border bg-bg/25 p-4", warn && "border-warning/35 bg-warning/5")} data-traffic-node><div className="flex items-center justify-between gap-3"><span className="text-micro font-semibold uppercase tracking-[0.12em] text-text-faint">{step} · {title}</span><b className={cn("text-micro", warn ? "text-warning-text" : "text-success-text")}>{state}</b></div><h3 className="mt-4 text-2xl font-bold tabular-nums text-text">{value}</h3><p className="mt-1 text-meta text-text-muted">{description}</p><div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3">{metrics.map(([label, metric, metricWarn]) => <div key={label}><span className="block text-micro text-text-faint">{label}</span><strong className={cn("mt-1 block text-meta font-semibold tabular-nums text-text", metricWarn && "text-warning-text")}>{metric}</strong></div>)}</div>{progress !== null && <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-bg ring-1 ring-inset ring-border"><i className={cn("block h-full rounded-full bg-gradient-to-r", warn ? "from-warning/50 to-warning" : "from-accent/50 to-accent")} style={{ width: `${Math.max(2, progress)}%` }} /></div>}</article>;
}

function QuietCard({ kicker, title, hint, value, warn = false }: { kicker: string; title: string; hint: string; value: string; warn?: boolean }) {
  return <article className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg/25 p-4"><div><span className="text-micro uppercase tracking-[0.12em] text-text-faint">{kicker}</span><strong className="mt-1 block text-meta text-text">{title}</strong><small className="mt-1 block text-micro text-text-muted">{hint}</small></div><b className={cn("shrink-0 text-meta tabular-nums text-text-muted", warn && "text-warning-text")}>{value}</b></article>;
}

function breakdownAt(data: ZeroAllData, group: CounterGroupPath, key: string): BreakdownRow[] {
  return breakdownRows(data[group]?.[key]);
}

function FailurePanel({ data, window, windowSeconds }: { data: ZeroAllData; window: CounterSnapshot | undefined; windowSeconds: number | null }) {
  const s = useStrings();
  const v = s.details.pages.counters.view;
  const metrics = counterViewMetrics(window);
  const bad = numberAt(data, "core.connections_bad_total") ?? 0;
  const connections = numberAt(data, "core.connections_total") ?? 0;
  const timeout = numberAt(data, "core.handshake_timeouts_total") ?? 0;
  const upstreamFail = numberAt(data, "upstream.connect_fail_total") ?? 0;
  const attempts = numberAt(data, "upstream.connect_attempt_total") ?? 0;
  const uptime = numberAt(data, "core.uptime_seconds");
  const connectionsRows = breakdownAt(data, "core", "connections_bad_by_class");
  const handshakeRows = breakdownAt(data, "core", "handshake_failures_by_class");
  const codeRows = breakdownAt(data, "middle_proxy", "handshake_error_codes");
  return (
    <section className="p-4 sm:p-5" data-testid="counters-failures-panel">
      <SectionHead kicker={v.failureDiagnostics} title={v.newThenAccumulated} meta={uptime === null ? undefined : `Uptime · ${formatDurationApprox(uptime * 1000, s)}`} />
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
        <FailureStat label={v.newSignalsWindow} value={metrics.newFailureSignals === null ? "—" : formatNumber(s, metrics.newFailureSignals)} hint={v.crossFamilyNavigation} warn={(metrics.newFailureSignals ?? 0) > 0} />
        <FailureStat label="Bad connections" value={formatNumber(s, bad)} hint={fill(v.lifetimeShare, { value: percent(s, ratio(bad, connections)) })} />
        <FailureStat label="Handshake timeout" value={formatNumber(s, timeout)} hint={v.accumulated} />
        <FailureStat label="Upstream fail" value={formatNumber(s, upstreamFail)} hint={fill(v.lifetimeAttemptsShare, { value: percent(s, ratio(upstreamFail, attempts)) })} />
      </div>
      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <ReasonCard title={v.whyConnectionsFailed} path="core.connections_bad_by_class" rows={connectionsRows} window={window} windowSeconds={windowSeconds} />
        <ReasonCard title={v.whyHandshakeFailed} path="core.handshake_failures_by_class" rows={handshakeRows} window={window} windowSeconds={windowSeconds} />
        <ReasonCard title={v.middleProxyRejections} path="middle_proxy.handshake_error_codes" rows={codeRows} window={window} windowSeconds={windowSeconds} wide />
      </div>
    </section>
  );
}

function FailureStat({ label, value, hint, warn = false }: { label: string; value: string; hint: string; warn?: boolean }) {
  return <div className={cn("bg-surface px-4 py-3", warn && "bg-warning/5")}><span className="block text-micro text-text-faint">{label}</span><strong className={cn("mt-1 block text-xl font-bold tabular-nums text-text", warn && "text-warning-text")}>{value}</strong><small className="mt-1 block text-micro text-text-muted">{hint}</small></div>;
}

function ReasonCard({ title, path, rows, window, windowSeconds, wide = false }: { title: string; path: string; rows: BreakdownRow[]; window: CounterSnapshot | undefined; windowSeconds: number | null; wide?: boolean }) {
  const s = useStrings();
  const v = s.details.pages.counters.view;
  const max = Math.max(...rows.map((row) => row.total), 1);
  return <article className={cn("rounded-xl border border-border bg-bg/25 p-4", wide && "xl:col-span-2")}><header className="flex flex-wrap items-end justify-between gap-2"><div><span className="font-mono text-micro text-text-faint">{path}[]</span><h3 className="mt-1 text-meta font-semibold text-text">{title}</h3></div><span className="text-micro text-text-muted">{fill(v.classesCount, { count: formatNumber(s, rows.length) })}</span></header>{rows.length === 0 ? <div className="mt-4 flex items-center gap-3 rounded-xl border border-success/20 bg-success/5 px-4 py-4"><span className="grid h-8 w-8 place-items-center rounded-full border border-success/30 text-success-text">✓</span><div><strong className="block text-meta text-text">{v.noCodes}</strong><span className="mt-1 block text-micro text-text-muted">{v.emptyArrayHonest}</span></div></div> : <div className="mt-4 space-y-px overflow-hidden rounded-xl border border-border bg-border">{[...rows].sort((a, b) => b.total - a.total).map((row) => { const delta = window?.[`${path}.${row.id}`] ?? null; return <div key={row.id} className={cn("grid gap-3 bg-surface px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(100px,.55fr)_6rem] sm:items-center", (delta ?? 0) > 0 && "bg-gradient-to-r from-warning/10 to-surface")}><div className="min-w-0"><strong className="block break-all text-meta text-text">{row.id}</strong><small className="mt-1 block text-micro text-text-muted">{v.accumulatedCause}</small></div><div className="h-2 overflow-hidden rounded-full bg-bg ring-1 ring-inset ring-border"><i className={cn("block h-full rounded-full bg-gradient-to-r", (delta ?? 0) > 0 ? "from-warning/60 to-warning" : "from-accent/50 to-accent")} style={{ width: `${Math.max(4, row.total / max * 100)}%` }} /></div><div className="flex items-end justify-between gap-3 sm:block sm:text-right"><strong className="text-base font-bold tabular-nums text-text">{formatNumber(s, row.total)}</strong><small className="block text-micro text-text-faint">{v.sinceStart}</small><b className={cn("block text-micro", (delta ?? 0) > 0 ? "text-warning-text" : "text-text-muted")}>{delta === null ? v.baseline : fill(v.deltaPerWindow, { delta: signed(s, delta), window: windowLabel(s, windowSeconds) })}</b></div></div>; })}</div>}</article>;
}

function ExplorerPanel({ data, window, sinceOpen, windowSeconds, reset }: { data: ZeroAllData; window: CounterSnapshot | undefined; sinceOpen: CounterSnapshot | undefined; windowSeconds: number | null; reset: () => void }) {
  const s = useStrings();
  const v = s.details.pages.counters.view;
  const nowMs = useNow(30_000);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CounterFilter>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<CounterGroupPath>>(() => new Set(COUNTER_GROUP_PATHS));
  const rows = useMemo(() => scalarCounterRows(data).map((row) => ({ ...row, field: describeField(row.path, s) })), [data, s]);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    const delta = window?.[row.path];
    if (filter === "nonzero" && (row.value === 0 || row.value === false || row.value === null || row.value === undefined) && !delta) return false;
    if (filter === "errors" && !isFailureCounterPath(row.path)) return false;
    return !needle || `${row.group} ${row.path} ${row.field.description}`.toLocaleLowerCase().includes(needle);
  });
  const groupLabels: Record<CounterGroupPath, string> = { core: s.details.pages.counters.groups.core, upstream: s.details.pages.counters.groups.upstream, middle_proxy: s.details.pages.counters.groups.middleProxy, pool: s.details.pages.counters.groups.pool, desync: s.details.pages.counters.groups.desync };
  return (
    <section className="p-4 sm:p-5" data-testid="counters-explorer-panel">
      <SectionHead kicker={v.technicalExplorer} title={v.allBySubsystem} meta={v.absoluteAndMeasured} />
      <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-bg/30 p-3 lg:flex-row lg:items-center lg:justify-between">
        <label className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 lg:w-80"><span className="text-text-faint">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-meta text-text outline-none placeholder:text-text-faint" placeholder={v.searchPlaceholder} aria-label={v.searchLabel} /></label>
        <div className="flex gap-1 overflow-x-auto">{(["all", "nonzero", "errors"] as const).map((id) => <button key={id} type="button" onClick={() => setFilter(id)} className={cn("shrink-0 rounded-lg px-3 py-2 text-meta font-semibold", filter === id ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-surface-hover")}>{id === "all" ? v.filterAll : id === "nonzero" ? v.filterNonzero : v.filterErrors}</button>)}<button type="button" onClick={reset} className="shrink-0 rounded-lg border border-border px-3 py-2 text-meta font-semibold text-text-muted hover:border-accent/40 hover:text-text">{v.resetBaseline}</button></div>
      </div>
      <div className="mt-4 space-y-3">{COUNTER_GROUP_PATHS.map((group) => { const groupRows = filtered.filter((row) => row.group === group); if (!groupRows.length) return null; const open = expanded.has(group); return <section key={group} className="overflow-hidden rounded-xl border border-border bg-bg/25" data-counter-group={group}><button type="button" className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left" aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(group)) next.delete(group); else next.add(group); return next; })}><span><strong className="block text-meta font-semibold text-text">{groupLabels[group]}</strong><small className="mt-1 block text-micro text-text-muted">{fill(v.rowsAndKeys, { count: formatNumber(s, groupRows.length) })}</small></span><b className={cn("text-text-muted transition-transform", open && "rotate-180")}>⌄</b></button>{open && <div className="border-t border-border"><div className="hidden grid-cols-[minmax(0,1fr)_8rem_7rem_7rem] gap-3 bg-bg/40 px-4 py-2 text-micro text-text-faint sm:grid"><span>{v.counter}</span><span className="text-right">{v.absolute}</span><span className="text-right">{windowLabel(s, windowSeconds)}</span><span className="text-right">{v.sinceOpen}</span></div>{groupRows.map((row) => { const formatted = formatValue(row.value, s, { nowMs, formatter: row.field.format, unit: row.field.unit, present: true }); const delta = typeof row.value === "number" ? window?.[row.path] ?? null : null; const totalDelta = typeof row.value === "number" ? sinceOpen?.[row.path] ?? null : null; const warning = isFailureCounterPath(row.path) && (delta ?? 0) > 0; return <div key={row.path} className={cn("grid gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_7rem] sm:items-center", warning && "bg-warning/5")} data-counter-row><div className="min-w-0"><code className="block break-all text-meta text-text">{row.path}</code><span className="mt-1 block text-micro leading-relaxed text-text-muted">{row.field.description}</span></div><CounterCell label={v.absolute} value={formatted.text} /><CounterCell label={windowLabel(s, windowSeconds)} value={signed(s, delta)} warn={warning} /><CounterCell label={v.sinceOpen} value={signed(s, totalDelta)} /></div>; })}</div>}</section>; })}{filtered.length === 0 && <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center text-meta text-text-muted">{v.noMatches}</div>}</div>
    </section>
  );
}

function CounterCell({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return <div className="flex items-end justify-between gap-3 sm:block sm:text-right"><small className="text-micro text-text-faint sm:hidden">{label}</small><strong className={cn("text-meta font-semibold tabular-nums text-text", warn && "text-warning-text")}>{value}</strong></div>;
}

function TechnicalPanel({ data, windowSeconds }: { data: ZeroAllData; windowSeconds: number | null }) {
  const s = useStrings();
  const v = s.details.pages.counters.view;
  const [open, setOpen] = useState(false);
  const rows = [["Endpoint", "GET /v1/stats/zero/all", v.snapshotNotHistory], [v.panelInterval, windowLabel(s, windowSeconds), v.neighborDifference], [v.processReset, "core.uptime_seconds", v.reanchorsBaseline], ["generated_at_epoch_secs", formatNumber(s, data.generated_at_epoch_secs), v.sourceTimestamp]];
  return <section className="border-t border-border bg-bg/30"><button type="button" className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left sm:px-5" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span><strong className="block text-meta font-semibold text-text">{v.sourceAndMethod}</strong><small className="mt-0.5 block text-micro text-text-muted">{v.technicalDescription}</small></span><span className={cn("text-text-muted transition-transform", open && "rotate-180")}>⌄</span></button>{open && <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-4" data-testid="counters-technical-grid">{rows.map(([key, value, hint]) => <div key={key} className="min-w-0 bg-surface px-4 py-3"><span className="block text-micro text-text-faint">{key}</span><strong className="mt-1 block break-all text-meta font-semibold text-text">{value}</strong><small className="mt-1 block text-micro text-text-muted">{hint}</small></div>)}</div>}</section>;
}

function SourceNotice({ kind, onRetry }: { kind: "loading" | "error"; onRetry: () => void }) {
  const v = useStrings().details.pages.counters.view;
  return <div className="p-5"><div className="rounded-xl border border-dashed border-border px-5 py-10 text-center"><h2 className="text-h2 font-semibold text-text">{kind === "loading" ? v.loading : v.sourceError}</h2><p className="mx-auto mt-2 max-w-prose text-meta text-text-muted">{kind === "loading" ? v.loadingDescription : v.sourceErrorDescription}</p>{kind === "error" && <button type="button" onClick={onRetry} className="mt-4 rounded-lg border border-border px-3 py-2 text-meta font-semibold text-text hover:border-accent/45">{v.retry}</button>}</div></div>;
}

export function CountersPage() {
  const s = useStrings();
  const v = s.details.pages.counters.view;
  const navigate = useNavigate();
  const { mode } = useDisplayMode();
  const nowMs = useNow(1_000);
  const [tab, setTab] = useState<CountersTab>("activity");
  const zero = useQuery({ ...getTelemtZeroOptions(), refetchInterval: countersRefetchInterval(mode) });
  const { window, sinceOpen, windowSeconds, restarted, reset } = useCounterDeltas(zero.data, zero.dataUpdatedAt);
  const inputs: Record<string, DetailSourceInput> = { zero: { kind: "query", isPending: zero.isPending, isError: zero.isError, error: zero.error ?? null, data: zero.data, dataUpdatedAt: zero.dataUpdatedAt } };
  const sources = useDetailSources(countersPageDefinition.sources, inputs);
  const metrics = counterViewMetrics(window);
  const failureCount = metrics.newFailureSignals;
  const count = zero.data ? counterLeaves(zero.data).length : null;
  const tabs: Array<[CountersTab, string, string, number | null]> = [["activity", v.activityTab, v.activityTabShort, null], ["failures", v.failuresTab, v.failuresTabShort, failureCount], ["explorer", v.explorerTab, v.explorerTabShort, count]];
  return (
    <div className="mx-auto w-full max-w-[1160px]" data-testid="counters-detail">
      <section className="overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="px-4 py-5 sm:px-5"><DetailHeader title={s.details.pages.counters.title} description={v.description} breadcrumb={v.breadcrumb} status={sources.status} freshnessMs={sources.freshnessMs} nowMs={nowMs} onBack={() => void navigate({ to: "/pulse" })} /></div>
        {zero.data && <CountersHero metrics={metrics} windowSeconds={windowSeconds} restarted={restarted} />}
        {zero.data && <nav className="grid grid-cols-3 gap-1 border-b border-border bg-bg/40 px-3 py-2 sm:flex sm:overflow-x-auto" role="tablist" aria-label={s.details.pages.counters.title}>{tabs.map(([id, label, shortLabel, badge]) => <button key={id} type="button" role="tab" aria-label={label} aria-selected={tab === id} onClick={() => setTab(id)} className={cn("min-w-0 rounded-lg px-1.5 py-2 text-micro font-semibold sm:shrink-0 sm:px-3 sm:text-meta", tab === id ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-surface-hover")}><span className="sm:hidden">{shortLabel}</span><span className="hidden sm:inline">{label}</span>{badge !== null && <b className="ml-1 rounded-md bg-bg/60 px-1 py-0.5 text-micro tabular-nums sm:ml-2 sm:px-1.5">{formatNumber(s, badge)}</b>}</button>)}</nav>}
        <div className="min-h-[360px]">{!zero.data ? <SourceNotice kind={zero.isError ? "error" : "loading"} onRetry={() => void zero.refetch()} /> : tab === "activity" ? <ActivityPanel data={zero.data} metrics={metrics} windowSeconds={windowSeconds} restarted={restarted} /> : tab === "failures" ? <FailurePanel data={zero.data} window={window} windowSeconds={windowSeconds} /> : <ExplorerPanel data={zero.data} window={window} sinceOpen={sinceOpen} windowSeconds={windowSeconds} reset={reset} />}</div>
        {zero.data && <TechnicalPanel data={zero.data} windowSeconds={windowSeconds} />}
      </section>
    </div>
  );
}
