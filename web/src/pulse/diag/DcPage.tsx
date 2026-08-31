import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatNumber, localeOf, useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type {
  DcEndpointWriters,
  DcStatus,
  RuntimeMinimalDcPath,
  RuntimeTopic,
  UpstreamsTopic,
} from "../../realtime/topics";
import { IconChevronDown } from "../../ui/icons";
import { StatePill, type State } from "../../ui/StatePill";
import { DetailHeader } from "../details-builder/DetailHeader";
import { dcPageDefinition } from "../details-builder/definitions/dc";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { DC_RTT_WARN_MS, dcRouteGroups, type DcRouteGroup } from "../widgets/dc.helpers";
import { resolveGated } from "../widgets/gated";
import { dcPagePayload } from "./dc.helpers";

type PairTone = "ok" | "warn" | "error" | "latency";
type RouteIssue = "coverage" | "fresh" | "endpoints" | "latency" | null;

function routeLabel(dc: DcStatus): "RPC" | "Media" {
  return dc.dc < 0 ? "Media" : "RPC";
}

function routeIssue(dc: DcStatus): RouteIssue {
  if (dc.coverage_pct <= 0 || dc.alive_writers <= 0) return "coverage";
  if (dc.coverage_pct < 100 || dc.alive_writers < dc.required_writers) return "coverage";
  if (dc.fresh_coverage_pct < dc.coverage_pct) return "fresh";
  if (dc.available_endpoints < dc.endpoints.length) return "endpoints";
  if (dc.rtt_ms !== null && dc.rtt_ms > DC_RTT_WARN_MS) return "latency";
  return null;
}

function routeTone(dc: DcStatus): PairTone {
  if (dc.coverage_pct <= 0 || dc.alive_writers <= 0) return "error";
  const issue = routeIssue(dc);
  if (issue === "latency") return "latency";
  return issue === null ? "ok" : "warn";
}

function pairTone(pair: DcRouteGroup<DcStatus>): PairTone {
  const tones = [pair.main, pair.media]
    .filter((dc): dc is DcStatus => dc !== undefined)
    .map(routeTone);
  if (tones.includes("error")) return "error";
  if (tones.includes("warn")) return "warn";
  if (tones.includes("latency")) return "latency";
  return "ok";
}

function stateForTone(tone: PairTone): State {
  if (tone === "error") return "error";
  if (tone === "warn" || tone === "latency") return "warn";
  return "ok";
}

function formatRtt(value: number | null, s: Dict): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${formatNumber(s, Math.round(value))} ${s.details.pages.dc.view.ms}`;
}

function statusLabel(tone: PairTone, s: Dict): string {
  if (tone === "error") return s.details.pages.dc.view.unavailable;
  if (tone === "warn") return s.details.pages.dc.view.needsAttention;
  if (tone === "latency") return s.details.pages.dc.view.highRtt;
  return s.details.pages.dc.view.healthy;
}

function routeReason(dc: DcStatus, s: Dict): string {
  const prefix = routeLabel(dc);
  const issue = routeIssue(dc);
  if (issue === "coverage") {
    return `${prefix}: ${s.details.pages.dc.view.coverage} ${formatNumber(s, Math.round(dc.coverage_pct))} %, ${s.details.pages.dc.view.writers.toLowerCase()} ${formatNumber(s, dc.alive_writers)}/${formatNumber(s, dc.required_writers)}`;
  }
  if (issue === "fresh") {
    return `${prefix}: ${s.details.pages.dc.view.freshWriters.toLowerCase()} ${formatNumber(s, dc.fresh_alive_writers)}/${formatNumber(s, dc.required_writers)}`;
  }
  if (issue === "endpoints") {
    return `${prefix}: ${s.details.pages.dc.view.endpointsAvailable.toLowerCase()} ${formatNumber(s, dc.available_endpoints)}/${formatNumber(s, dc.endpoints.length)}`;
  }
  if (issue === "latency") {
    return `${prefix}: RTT ${formatRtt(dc.rtt_ms, s)}`;
  }
  return "";
}

function pairReason(pair: DcRouteGroup<DcStatus>, s: Dict): string {
  for (const dc of [pair.main, pair.media]) {
    if (dc && routeIssue(dc) !== null && routeIssue(dc) !== "latency") return routeReason(dc, s);
  }
  for (const dc of [pair.main, pair.media]) {
    if (dc && routeIssue(dc) === "latency") return routeReason(dc, s);
  }
  return s.details.pages.dc.view.pairHealthy;
}

function CompactRoute({ dc, s }: { dc: DcStatus | undefined; s: Dict }) {
  if (!dc) return <span className="text-micro text-text-faint">—</span>;
  const issue = routeIssue(dc);
  return (
    <span className="grid grid-cols-[auto_1fr_auto] items-center gap-1 text-micro">
      <i className={cn("h-1.5 w-1.5 rounded-full", dc.dc < 0 ? "bg-[#9c7fe8]" : "bg-[#58aee8]")} />
      <strong className={cn(issue && issue !== "latency" ? "text-warn" : "text-text-muted")}>
        {routeLabel(dc)} {formatNumber(s, Math.round(dc.coverage_pct))}%
      </strong>
      <span className={cn("tabular-nums", issue === "latency" ? "text-warn" : "text-text-faint")}>
        {formatRtt(dc.rtt_ms, s)}
      </span>
    </span>
  );
}

function CoverageScale() {
  return (
    <span
      className="pointer-events-none absolute inset-y-2 right-2 w-6 text-[10px] tabular-nums text-text-faint"
      aria-hidden="true"
    >
      <i className="absolute right-0 top-0 h-full border-r border-border" />
      {[100, 66, 33, 0].map((tick) => (
        <span
          key={tick}
          className="absolute right-0 flex items-center gap-1"
          style={{
            top: `${100 - tick}%`,
            transform: tick === 0 ? "translateY(-100%)" : "translateY(-50%)",
          }}
        >
          <b className="font-normal">{tick}</b>
          <i className="block w-1.5 border-t border-border" />
        </span>
      ))}
    </span>
  );
}

function RouteLane({ dc, s }: { dc: DcStatus; s: Dict }) {
  const tone = routeTone(dc);
  const coverage = Math.max(0, Math.min(100, dc.coverage_pct));
  const coverageState = dc.coverage_pct <= 0 ? "error" : dc.coverage_pct < 100 ? "warn" : "ok";
  const fillColor =
    coverageState === "error"
      ? "linear-gradient(180deg, rgb(var(--error) / 0.20), rgb(var(--error) / 0.08))"
      : coverageState === "warn"
        ? "linear-gradient(180deg, rgb(var(--warn) / 0.24), rgb(var(--warn) / 0.09))"
        : "linear-gradient(180deg, rgb(var(--ok) / 0.22), rgb(var(--ok) / 0.08))";
  const writersWarn = dc.alive_writers < dc.required_writers;
  const freshWarn = dc.fresh_coverage_pct < dc.coverage_pct;
  const endpointsWarn = dc.available_endpoints < dc.endpoints.length;
  const rttWarn = dc.rtt_ms !== null && dc.rtt_ms > DC_RTT_WARN_MS;

  return (
    <section
      className="relative min-h-[276px] min-w-0 overflow-hidden bg-surface-2 px-4 py-4 sm:px-5"
      data-dc-route={dc.dc}
    >
      <span
        className="pointer-events-none absolute inset-x-0 bottom-0 transition-[height]"
        style={{ height: `${coverage}%`, background: fillColor }}
        aria-hidden="true"
      />
      <CoverageScale />
      <div className="relative z-10 flex h-full min-h-[244px] flex-col pr-7">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                "grid h-9 w-9 place-items-center rounded-lg border text-micro font-bold",
                dc.dc < 0
                  ? "border-[#9c7fe8]/40 bg-[#9c7fe8]/15 text-[#b9a5f2]"
                  : "border-[#58aee8]/40 bg-[#58aee8]/15 text-[#7dc5f3]",
              )}
            >
              {dc.dc < 0 ? "M" : "R"}
            </span>
            <div>
              <strong className="block text-h3 text-text">{routeLabel(dc)}</strong>
              <span className="block text-micro text-text-muted">
                DC {dc.dc > 0 ? "+" : "−"}
                {Math.abs(dc.dc)}
              </span>
            </div>
          </div>
          <StatePill state={stateForTone(tone)}>{statusLabel(tone, s)}</StatePill>
        </header>

        <div className="mt-7 grid grid-cols-2 items-end gap-4">
          <div>
            <span className="block text-label uppercase tracking-[0.1em] text-text-muted">RTT</span>
            <strong
              className={cn(
                "mt-0.5 block text-[2rem] font-bold leading-none tabular-nums",
                rttWarn ? "text-warn" : "text-text",
              )}
            >
              {dc.rtt_ms === null ? "—" : formatNumber(s, Math.round(dc.rtt_ms))}
              {dc.rtt_ms !== null && (
                <small className="ml-1 text-meta font-semibold text-text-muted">
                  {s.details.pages.dc.view.ms}
                </small>
              )}
            </strong>
          </div>
          <div className="text-right">
            <span className="block text-label uppercase tracking-[0.1em] text-text-muted">
              {s.details.pages.dc.view.coverage}
            </span>
            <strong
              className={cn(
                "mt-0.5 block text-h2 tabular-nums",
                coverageState === "ok"
                  ? "text-text"
                  : coverageState === "warn"
                    ? "text-warn"
                    : "text-error",
              )}
            >
              {formatNumber(s, Math.round(dc.coverage_pct))}%
            </strong>
          </div>
        </div>

        <dl className="mt-auto grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/80 pt-4 sm:grid-cols-4">
          <div>
            <dt className="text-micro text-text-muted">{s.details.pages.dc.view.writers}</dt>
            <dd
              className={cn(
                "mt-0.5 text-meta font-semibold tabular-nums",
                writersWarn ? "text-warn" : "text-text",
              )}
            >
              {formatNumber(s, dc.alive_writers)}/{formatNumber(s, dc.required_writers)}
            </dd>
          </div>
          <div>
            <dt className="text-micro text-text-muted">{s.details.pages.dc.view.fresh}</dt>
            <dd
              className={cn(
                "mt-0.5 text-meta font-semibold tabular-nums",
                freshWarn ? "text-warn" : "text-text",
              )}
            >
              {formatNumber(s, Math.round(dc.fresh_coverage_pct))}%
            </dd>
          </div>
          <div>
            <dt className="text-micro text-text-muted">{s.details.pages.dc.view.endpoints}</dt>
            <dd
              className={cn(
                "mt-0.5 text-meta font-semibold tabular-nums",
                endpointsWarn ? "text-warn" : "text-text",
              )}
            >
              {formatNumber(s, dc.available_endpoints)}/{formatNumber(s, dc.endpoints.length)}
            </dd>
          </div>
          <div>
            <dt className="text-micro text-text-muted">{s.details.pages.dc.view.load}</dt>
            <dd className="mt-0.5 text-meta font-semibold tabular-nums text-text">
              {formatNumber(s, dc.load)}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function endpointRows(dc: DcStatus): DcEndpointWriters[] {
  const byEndpoint = new Map(dc.endpoint_writers.map((row) => [row.endpoint, row.active_writers]));
  return dc.endpoints.map((endpoint) => ({
    endpoint,
    active_writers: byEndpoint.get(endpoint) ?? 0,
  }));
}

function EndpointColumn({ dc, s }: { dc: DcStatus; s: Dict }) {
  const rows = endpointRows(dc);
  return (
    <section className="min-w-0" data-endpoint-route={dc.dc}>
      <header className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <strong className="text-meta text-text">
          {routeLabel(dc)} · DC {dc.dc > 0 ? "+" : "−"}
          {Math.abs(dc.dc)}
        </strong>
        <span className="text-micro text-text-muted">
          {formatNumber(s, dc.alive_writers)} writers · {formatNumber(s, dc.available_endpoints)}/
          {formatNumber(s, dc.endpoints.length)} {s.details.pages.dc.view.available}
        </span>
      </header>
      <div className="overflow-hidden rounded-lg border border-border">
        {rows.map((row) => (
          <div
            key={row.endpoint}
            className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-surface-2 px-3 py-2 last:border-b-0"
          >
            <code className="truncate font-mono text-micro text-text-muted" title={row.endpoint}>
              {row.endpoint}
            </code>
            <span className="whitespace-nowrap text-micro text-text-muted">
              <strong
                className={cn("text-meta", row.active_writers === 0 ? "text-warn" : "text-text")}
              >
                {formatNumber(s, row.active_writers)}
              </strong>{" "}
              writers
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="px-3 py-4 text-meta text-text-muted">
            {s.details.pages.dc.view.noEndpoints}
          </p>
        )}
      </div>
    </section>
  );
}

function CapacityRoute({ dc, s }: { dc: DcStatus; s: Dict }) {
  return (
    <section data-capacity-route={dc.dc}>
      <header className="mb-2 flex items-center justify-between gap-3">
        <strong className="text-meta text-text">
          {routeLabel(dc)} · DC {dc.dc > 0 ? "+" : "−"}
          {Math.abs(dc.dc)}
        </strong>
        <span className={cn("text-micro", dc.floor_capped ? "text-warn" : "text-text-muted")}>
          {dc.floor_capped ? s.details.pages.dc.view.capped : s.details.pages.dc.view.notCapped}
        </span>
      </header>
      <dl className="grid grid-cols-3 overflow-hidden rounded-lg border border-border bg-border">
        {[
          [s.details.pages.dc.view.minimum, dc.floor_min],
          [s.details.pages.dc.view.target, dc.floor_target],
          [s.details.pages.dc.view.maximum, dc.floor_max],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-surface-2 px-2 py-3 text-center">
            <dt className="text-micro text-text-muted">{label}</dt>
            <dd className="mt-0.5 text-h3 font-semibold tabular-nums text-text">
              {formatNumber(s, Number(value))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function technicalRows(
  pair: DcRouteGroup<DcStatus>,
  path: RuntimeMinimalDcPath | undefined,
  middleProxyEnabled: boolean,
  reason: string | undefined,
  generatedAt: number,
  s: Dict,
): Array<[string, string]> {
  const stamp = new Intl.DateTimeFormat(localeOf(s), {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(generatedAt * 1000));
  return [
    [
      "network_path.ip_preference",
      path?.ip_preference && path.ip_preference !== "unknown" ? path.ip_preference : "—",
    ],
    ["network_path.selected_addr_v4", path?.selected_addr_v4 ?? "—"],
    ["network_path.selected_addr_v6", path?.selected_addr_v6 ?? "—"],
    ["middle_proxy_enabled", String(middleProxyEnabled)],
    ["reason", reason ?? "—"],
    ["generated_at_epoch_secs", `${formatNumber(s, generatedAt)} · ${stamp}`],
    ["rpc.dc", pair.main ? String(pair.main.dc) : "—"],
    ["media.dc", pair.media ? String(pair.media.dc) : "—"],
  ];
}

export function DcPage() {
  const s = useStrings();
  const navigate = useNavigate();
  const nowMs = useNow();
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const pairListRef = useRef<HTMLDivElement>(null);

  const dcs = upstreams.data?.dcs ?? null;
  const minimal = runtime.data ? resolveGated(runtime.data.minimal) : null;
  const networkPaths = minimal?.status === "ok" ? minimal.data.network_path : [];
  const payload = dcPagePayload(dcs, networkPaths);

  const inputs: Record<string, DetailSourceInput> = {
    upstreams: {
      kind: "topic",
      snapshot: upstreams,
      ...(dcs
        ? {
            gated: {
              enabled: dcs.middle_proxy_enabled,
              ...(dcs.reason !== undefined ? { reason: dcs.reason } : {}),
              data: dcs.dcs,
            },
          }
        : {}),
      generatedAt: dcs?.generated_at_epoch_secs ?? null,
    },
    runtime: { kind: "topic", snapshot: runtime, gated: runtime.data?.minimal ?? null },
  };
  const sources = useDetailSources(dcPageDefinition.sources, inputs);

  const pairs = dcRouteGroups(payload?.dcs ?? []);
  const defaultPair =
    pairs.find((pair) => pairTone(pair) === "error" || pairTone(pair) === "warn") ??
    pairs[0] ??
    null;
  const selected = pairs.find((pair) => pair.id === selectedId) ?? defaultPair;
  const selectedTone = selected ? pairTone(selected) : "ok";
  const selectedPath = selected
    ? payload?.network_paths?.find((path) => path.dc === selected.id)
    : undefined;
  const technical =
    selected && payload
      ? technicalRows(
          selected,
          selectedPath,
          payload.middle_proxy_enabled,
          payload.reason,
          payload.generated_at_epoch_secs,
          s,
        )
      : [];

  useEffect(() => {
    const list = pairListRef.current;
    if (!list || !selected) return;
    const button = list.querySelector<HTMLElement>(`[data-dc-pair="${selected.id}"]`);
    if (!button || list.scrollWidth <= list.clientWidth) return;
    list.scrollTo({
      left: button.offsetLeft - (list.clientWidth - button.offsetWidth) / 2,
      behavior: selectedId === null ? "auto" : "smooth",
    });
  }, [selected, selectedId]);

  return (
    <div className="mx-auto w-full max-w-[1160px]" data-testid="dc-detail">
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <DetailHeader
            title={s.details.pages.dc.title}
            description={s.details.pages.dc.description}
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
                  ? s.details.pages.dc.view.sourceUnavailable
                  : s.details.pages.dc.view.loading}
              </p>
              <p className="mt-1 text-meta text-text-muted">
                {upstreams.error ?? s.details.pages.dc.view.loadingDescription}
              </p>
            </div>
          </div>
        ) : pairs.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-5 text-center">
            <div>
              <p className="text-h3 font-semibold text-text">
                {s.details.pages.dc.view.noDataCenters}
              </p>
              <p className="mt-1 max-w-lg text-meta text-text-muted">
                {payload.reason ?? s.details.pages.dc.view.noDataCentersDescription}
              </p>
            </div>
          </div>
        ) : (
          <>
            <section className="border-b border-border px-4 py-5 sm:px-5" data-testid="dc-pairs">
              <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                    {s.details.pages.dc.view.sixPairs}
                  </p>
                  <h2 className="mt-0.5 text-h3 font-semibold text-text">
                    {s.details.pages.dc.view.chooseDataCenter}
                  </h2>
                </div>
                <div className="flex gap-3 text-micro text-text-muted">
                  <span className="inline-flex items-center gap-1">
                    <i className="h-1.5 w-1.5 rounded-full bg-[#58aee8]" />
                    RPC +N
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <i className="h-1.5 w-1.5 rounded-full bg-[#9c7fe8]" />
                    Media −N
                  </span>
                </div>
              </header>

              <div
                ref={pairListRef}
                className="mt-4 grid snap-x snap-mandatory auto-cols-[minmax(145px,1fr)] grid-flow-col gap-2 overflow-x-auto pb-2 md:grid-flow-row md:grid-cols-3 md:overflow-visible md:pb-0 xl:grid-cols-6"
                data-testid="dc-pair-list"
                role="listbox"
                aria-label={s.details.pages.dc.view.dcPairs}
              >
                {pairs.map((pair) => {
                  const tone = pairTone(pair);
                  const active = selected?.id === pair.id;
                  return (
                    <button
                      key={pair.id}
                      type="button"
                      data-dc-pair={pair.id}
                      role="option"
                      aria-selected={active}
                      className={cn(
                        "relative min-h-[86px] snap-center overflow-hidden rounded-xl border px-3 py-3 text-left transition-colors",
                        active
                          ? "border-accent bg-accent/10"
                          : "border-border bg-surface-2 hover:bg-surface-3",
                      )}
                      onClick={() => setSelectedId(pair.id)}
                    >
                      <i
                        className={cn(
                          "absolute inset-y-2 left-0 w-0.5 rounded-full",
                          tone === "error"
                            ? "bg-error"
                            : tone === "warn"
                              ? "bg-warn"
                              : tone === "latency"
                                ? "bg-warn/75"
                                : "bg-ok",
                        )}
                      />
                      <strong className="block text-meta text-text">
                        DC {pair.id}
                        {pair.id >= 100 && (
                          <small className="ml-1 rounded bg-accent/15 px-1 py-0.5 text-[10px] text-accent">
                            CDN
                          </small>
                        )}
                      </strong>
                      <span className="mt-1.5 grid gap-1">
                        <CompactRoute dc={pair.main} s={s} />
                        <CompactRoute dc={pair.media} s={s} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {selected && (
              <>
                <section
                  className="border-b border-border px-4 py-5 sm:px-5"
                  data-testid="dc-selected-pair"
                >
                  <header className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                        {s.details.pages.dc.view.selectedPair}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2">
                        <h2 className="text-h2 font-semibold text-text">DC {selected.id}</h2>
                        {selected.id >= 100 && (
                          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-micro font-semibold text-accent">
                            CDN
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-left sm:text-right">
                      <StatePill state={stateForTone(selectedTone)}>
                        {statusLabel(selectedTone, s)}
                      </StatePill>
                      <p className="mt-1 text-micro text-text-muted">{pairReason(selected, s)}</p>
                    </div>
                  </header>

                  <div
                    className="mt-4 grid overflow-hidden rounded-xl border border-border lg:grid-cols-2"
                    data-testid="dc-route-pair"
                  >
                    {selected.main && <RouteLane dc={selected.main} s={s} />}
                    {selected.media && (
                      <div className="border-t border-border lg:border-l lg:border-t-0">
                        <RouteLane dc={selected.media} s={s} />
                      </div>
                    )}
                  </div>
                </section>

                <section className="grid border-b border-border lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
                  <div
                    className="min-w-0 border-b border-border px-4 py-5 sm:px-5 lg:border-b-0 lg:border-r"
                    data-testid="dc-endpoints"
                  >
                    <header className="flex flex-wrap items-end justify-between gap-2">
                      <div>
                        <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                          {s.details.pages.dc.view.destinations}
                        </p>
                        <h2 className="mt-0.5 text-h3 font-semibold text-text">
                          {s.details.pages.dc.view.endpointsAndWriters}
                        </h2>
                      </div>
                      <span className="text-micro text-text-muted">
                        {s.details.pages.dc.view.activeRequired}
                      </span>
                    </header>
                    <div className="mt-4 grid gap-5 sm:grid-cols-2">
                      {selected.main && <EndpointColumn dc={selected.main} s={s} />}
                      {selected.media && <EndpointColumn dc={selected.media} s={s} />}
                    </div>
                  </div>

                  <div className="min-w-0 px-4 py-5 sm:px-5" data-testid="dc-capacity">
                    <p className="text-label uppercase tracking-[0.12em] text-text-muted">
                      {s.details.pages.dc.view.adaptiveCapacity}
                    </p>
                    <h2 className="mt-0.5 text-h3 font-semibold text-text">
                      {s.details.pages.dc.view.writerRange}
                    </h2>
                    <div className="mt-4 grid gap-4">
                      {selected.main && <CapacityRoute dc={selected.main} s={s} />}
                      {selected.media && <CapacityRoute dc={selected.media} s={s} />}
                    </div>
                    <p className="mt-4 border-t border-border pt-3 text-micro leading-relaxed text-text-muted">
                      {s.details.pages.dc.view.capacityExplanation}
                    </p>
                  </div>
                </section>

                <details className="group px-4 py-4 sm:px-5" data-testid="dc-technical">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                    <span>
                      <strong className="block text-meta text-text">
                        {s.details.pages.dc.view.technical}
                      </strong>
                      <span className="block text-micro text-text-muted">
                        {s.details.pages.dc.view.technicalDescription}
                      </span>
                    </span>
                    <IconChevronDown className="shrink-0 transition-transform group-open:rotate-180" />
                  </summary>
                  <dl className="mt-4 grid border-t border-border sm:grid-cols-2 xl:grid-cols-3">
                    {technical.map(([label, value]) => (
                      <div
                        key={label}
                        className="min-w-0 border-b border-border px-3 py-3 sm:border-r"
                      >
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
          </>
        )}
      </section>
    </div>
  );
}
