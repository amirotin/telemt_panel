import type { ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fill, type Dict, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { getTelemtZeroOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type {
  RuntimeTopic,
  SecurityTopic,
  StatsSnapshot,
  UpstreamsTopic,
  UsersTopic,
  WebTopic,
} from "../../realtime/topics";
import { StatePill, type State } from "../../ui/StatePill";
import {
  IconActivity,
  IconChevronRight,
  IconClock,
  IconDesktop,
  IconDevice,
  IconGlobe,
  IconLink,
  IconServer,
  IconShield,
  IconTraffic,
  IconWarning,
  type IconProps,
} from "../../ui/icons";
import { formatRelativeAge } from "../details-builder/formatting";
import type { SummaryTone } from "../details-builder/model";
import type { DiagDomain } from "../types";
import { useHistorySeries } from "../useHistorySeries";
import { buildHubCards, type HubCard, type HubCardMetric } from "./hubCards";

const DOMAIN_ICONS: Record<DiagDomain, ComponentType<IconProps>> = {
  dc: IconGlobe,
  me: IconServer,
  security: IconShield,
  counters: IconActivity,
  connections: IconLink,
  upstreams: IconTraffic,
  nat: IconDevice,
  events: IconClock,
  web: IconDesktop,
};

const TRAFFIC_DOMAINS: readonly DiagDomain[] = ["connections", "upstreams", "dc", "me"];
const EVIDENCE_DOMAINS: readonly DiagDomain[] = ["nat", "events", "security", "counters"];
const ATTENTION_PRIORITY: readonly DiagDomain[] = [
  "connections",
  "upstreams",
  "dc",
  "me",
  "nat",
  "security",
  "counters",
  "events",
  "web",
];
const ATTENTION_SIGNAL: Partial<Record<DiagDomain, string>> = {
  connections: "admission",
  upstreams: "healthy",
  dc: "coverage",
  me: "degraded",
  nat: "reflection_age",
  security: "whitelist_state",
  counters: "quality",
  web: "lifecycle",
};

interface CardDisplay {
  primary: string;
  pair?: string;
}

const CARD_DISPLAY: Record<DiagDomain, CardDisplay> = {
  connections: { primary: "current_connections" },
  upstreams: { primary: "healthy", pair: "configured" },
  dc: { primary: "coverage" },
  me: { primary: "healthy_writers" },
  nat: { primary: "reflection_age" },
  events: { primary: "last_event" },
  security: { primary: "whitelist_state" },
  counters: { primary: "quality" },
  web: { primary: "lifecycle" },
};

const TONE_CLASSES: Record<SummaryTone, string> = {
  neutral: "text-text",
  good: "text-text",
  warn: "text-warn",
  bad: "text-error",
};

const HEALTH_LINE: Record<State, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  error: "bg-error",
  muted: "bg-border-strong",
};

function byDomain(cards: readonly HubCard[], domains: readonly DiagDomain[]): HubCard[] {
  const map = new Map(cards.map((card) => [card.domain, card]));
  return domains.flatMap((domain) => {
    const card = map.get(domain);
    return card ? [card] : [];
  });
}

function metric(card: HubCard, id: string): HubCardMetric | undefined {
  return card.metrics.find((item) => item.id === id);
}

function metricLabel(card: HubCard, item: HubCardMetric, s: Dict): string {
  const key = `${card.domain}.${item.id}`;
  switch (key) {
    case "connections.active_users":
      return s.hub.cardMetrics.active;
    case "counters.total":
      return s.hub.cardMetrics.total;
    case "me.degraded":
      return s.hub.cardMetrics.degraded;
    case "me.bound_clients":
      return s.hub.cardMetrics.clients;
    case "nat.attempts":
      return s.hub.cardMetrics.attempts;
    case "events.types":
      return s.hub.cardMetrics.types;
    case "events.dropped_total":
      return s.hub.cardMetrics.evicted;
    case "security.whitelist_size":
      return s.hub.cardMetrics.whitelist;
    case "upstreams.latency":
      return s.hub.cardMetrics.minRtt;
    default:
      return item.label;
  }
}

function metricText(card: HubCard, item: HubCardMetric, s: Dict): string {
  return card.domain === "security" && item.id === "log_level" && item.text === "silent"
    ? s.hub.values.silent
    : item.text;
}

function ageText(freshnessMs: number | null, s: Dict, nowMs: number): string {
  if (freshnessMs === null) return s.hub.freshnessUnknown;
  return formatRelativeAge(freshnessMs, s, nowMs).text;
}

function displayState(card: HubCard): { state: State; label: string } {
  if (card.health === "muted") return { state: card.pill, label: card.pillLabel };
  return { state: card.health, label: card.healthLabel };
}

function MetricValue({ card, item }: { card: HubCard; item: HubCardMetric }) {
  const s = useStrings();
  const warning = item.tone === "warn" || item.tone === "bad";
  return (
    <strong className={cn("flex min-w-0 items-center gap-1.5 truncate font-mono text-[16px] font-bold leading-tight tabular-nums", TONE_CLASSES[item.tone])}>
      {warning && <IconWarning className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      <span className="truncate">{metricText(card, item, s)}</span>
    </strong>
  );
}

function HubCardView({ card, nowMs }: { card: HubCard; nowMs: number }) {
  const s = useStrings();
  const Icon = DOMAIN_ICONS[card.domain];
  const state = displayState(card);
  const config = CARD_DISPLAY[card.domain];
  const primary = metric(card, config.primary) ?? card.metrics[0];
  const pair = config.pair ? metric(card, config.pair) : undefined;
  const excluded = new Set([primary?.id, pair?.id]);
  const facts = card.metrics.filter((item) => !excluded.has(item.id));
  const mainTone = primary?.tone ?? "neutral";

  return (
    <Link
      to="/pulse/diag/$domain"
      params={{ domain: card.domain }}
      data-testid={`hub-card-${card.domain}`}
      className={cn(
        "group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-surface p-3.5",
        "transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        card.health === "warn" && "border-warn/50",
        card.health === "error" && "border-error/55",
        card.health !== "warn" && card.health !== "error" && "border-border",
      )}
    >
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-0.5 opacity-80", HEALTH_LINE[card.health])} />
      <div className="relative flex items-start gap-2.5">
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-accent"><Icon className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate pr-9 text-[14px] font-bold text-text">{card.title}</h3>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <StatePill state={state.state}>{state.label}</StatePill>
            <span className="min-w-0 truncate text-[11px] text-text-muted">{ageText(card.freshnessMs, s, nowMs)}</span>
          </div>
        </div>
        <span className="absolute right-0 top-0 flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-2 text-text-faint transition-colors group-hover:text-text"><IconChevronRight className="h-3.5 w-3.5" /></span>
      </div>

      {primary ? (
        <>
          <div className="mt-4 flex min-h-11 items-end gap-2">
            <strong className={cn("font-mono text-[31px] font-bold leading-none tracking-tight tabular-nums", TONE_CLASSES[mainTone])}>{metricText(card, primary, s)}{pair ? ` / ${metricText(card, pair, s)}` : ""}</strong>
            <span className="pb-0.5 text-[12px] font-medium leading-tight text-text-muted">{metricLabel(card, primary, s)}</span>
          </div>
          {facts.length > 0 && (
            <div className={cn("mt-4 grid gap-4", facts.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
              {facts.map((item) => (
                <span key={item.id} className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-[12px] font-medium text-text-muted">{metricLabel(card, item, s)}</span>
                  <MetricValue card={card} item={item} />
                </span>
              ))}
            </div>
          )}
        </>
      ) : <p className="mt-4 text-[11px] leading-relaxed text-text-muted">{s.hub.unavailable}</p>}
    </Link>
  );
}

function HubGroup({ title, note, cards, nowMs }: { title: string; note: string; cards: HubCard[]; nowMs: number }) {
  return (
    <section className="flex flex-col gap-2.5">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-0.5">
        <h2 className="text-[13px] font-bold text-text">{title}</h2>
        <span className="text-[10px] text-text-faint">{note}</span>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => <HubCardView key={card.domain} card={card} nowMs={nowMs} />)}
      </div>
    </section>
  );
}

function AttentionBanner({ cards }: { cards: HubCard[] }) {
  const s = useStrings();
  const ordered = ATTENTION_PRIORITY.flatMap((domain) => {
    const card = cards.find((item) => item.domain === domain);
    return card ? [card] : [];
  });
  const issue = ordered.find((card) => card.health === "error") ?? ordered.find((card) => card.health === "warn");

  if (!issue) {
    return (
      <section className="grid min-h-[72px] grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl border border-ok/35 bg-ok-soft/20 px-3.5 py-2.5" data-testid="hub-attention">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-ok/40 bg-ok-soft/40 text-sm font-extrabold text-ok">✓</span>
        <span className="flex min-w-0 flex-col gap-1">
          <strong className="text-[13px] text-text">{s.hub.attention.healthy}</strong>
          <span className="text-[10px] text-text-muted">{s.hub.attention.healthyDescription}</span>
        </span>
      </section>
    );
  }

  const preferredSignal = ATTENTION_SIGNAL[issue.domain];
  const signal = issue.metrics.find((item) => item.id === preferredSignal)
    ?? issue.metrics.find((item) => item.tone === "bad")
    ?? issue.metrics.find((item) => item.tone === "warn");
  const headline = signal
    ? `${issue.title}: ${metricLabel(issue, signal, s)} — ${metricText(issue, signal, s)}`
    : `${issue.title}: ${issue.healthLabel}`;
  const error = issue.health === "error";

  return (
    <section className={cn("grid min-h-[72px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border px-3.5 py-2.5", error ? "border-error/45 bg-error-soft/20" : "border-warn/45 bg-warn-soft/20")} data-testid="hub-attention">
      <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg border text-sm font-extrabold", error ? "border-error/45 bg-error-soft/40 text-error" : "border-warn/45 bg-warn-soft/40 text-warn")}>!</span>
      <span className="flex min-w-0 flex-col gap-1">
        <strong className="text-[13px] leading-snug text-text">{headline}</strong>
        <span className="text-[10px] leading-snug text-text-muted">{s.hub.attention.description}</span>
      </span>
      <Link to="/pulse/diag/$domain" params={{ domain: issue.domain }} className="flex h-8 items-center gap-1 rounded-lg border border-border-strong bg-surface-2 px-2.5 text-[10px] font-semibold text-text transition-colors hover:bg-surface-3">
        <span className="hidden sm:inline">{s.hub.attention.open}</span><IconChevronRight className="h-3.5 w-3.5" />
      </Link>
    </section>
  );
}

function WebSourceRow({ card, nowMs }: { card: HubCard; nowMs: number }) {
  const s = useStrings();
  const state = displayState(card);
  const Icon = DOMAIN_ICONS.web;
  return (
    <Link to="/pulse/diag/$domain" params={{ domain: "web" }} data-testid="hub-card-web" className="group grid min-h-[60px] grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-xl border border-dashed border-border bg-surface/70 px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-surface">
      <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface-2 text-text-muted"><Icon className="h-4 w-4" /></span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-[12px] text-text">{card.title}</strong>
        <span className="truncate text-[9px] text-text-faint">{card.metrics.length ? ageText(card.freshnessMs, s, nowMs) : s.hub.unavailable}</span>
      </span>
      <StatePill state={state.state}>{state.label}</StatePill>
      <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-2 text-text-faint group-hover:text-text"><IconChevronRight className="h-3.5 w-3.5" /></span>
    </Link>
  );
}

export function PulseHub() {
  const s = useStrings();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const security = useSnapshot<SecurityTopic>("security");
  const users = useSnapshot<UsersTopic>("users");
  const web = useSnapshot<WebTopic>("web");
  const zero = useQuery(getTelemtZeroOptions());
  const attemptsHistory = useHistorySeries("attempts", 10_000);
  const refusalsHistory = useHistorySeries("refusals", 10_000);
  const nowMs = useNow();

  const cards = buildHubCards({
    stats,
    runtime,
    upstreams,
    security,
    users,
    web,
    counters: { kind: "query", isPending: zero.isPending, isError: zero.isError, error: zero.error ?? null, data: zero.data, dataUpdatedAt: zero.dataUpdatedAt },
    history: { attempts: attemptsHistory.data, refusals: refusalsHistory.data },
    nowMs,
  }, s);

  const traffic = byDomain(cards, TRAFFIC_DOMAINS);
  const evidence = byDomain(cards, EVIDENCE_DOMAINS);
  const webCard = cards.find((card) => card.domain === "web");
  const freshness = cards.filter((card) => card.health !== "muted" && card.freshnessMs !== null).map((card) => card.freshnessMs as number);
  const oldestFreshness = freshness.length ? Math.min(...freshness) : null;
  const freshnessProblem = cards.some((card) => card.status === "stale" || card.status === "partial" || card.status === "error");
  const globalFreshness = freshnessProblem
    ? s.hub.currentPartial
    : oldestFreshness === null
      ? s.hub.freshnessUnknown
      : fill(s.hub.current, { age: formatRelativeAge(oldestFreshness, s, nowMs).text });

  return (
    <div className="mx-auto flex w-full max-w-[1160px] flex-col gap-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <div className="min-w-0">
          <h1 className="text-title font-extrabold tracking-tight text-text">{s.pulse.title}</h1>
          <p className="mt-1 text-meta text-text-muted">{s.hub.lede}</p>
        </div>
        <span className={cn("flex shrink-0 items-center gap-2 pt-1 text-[10px]", freshnessProblem ? "text-warn" : "text-text-faint")}>
          <i className={cn("h-1.5 w-1.5 rounded-full", freshnessProblem ? "bg-warn" : "bg-ok")} />{globalFreshness}
        </span>
      </header>

      <AttentionBanner cards={cards} />
      <HubGroup title={s.hub.groups.traffic} note={s.hub.groups.trafficNote} cards={traffic} nowMs={nowMs} />
      <HubGroup title={s.hub.groups.evidence} note={s.hub.groups.evidenceNote} cards={evidence} nowMs={nowMs} />

      {webCard && (
        <section className="flex flex-col gap-2.5">
          <h2 className="px-0.5 text-[13px] font-bold text-text">{s.hub.groups.additional}</h2>
          <WebSourceRow card={webCard} nowMs={nowMs} />
        </section>
      )}
    </div>
  );
}
