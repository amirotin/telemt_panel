import type { ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useStrings } from "../../i18n";
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
import { StatePill } from "../../ui/StatePill";
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
import { GatedNote } from "../GatedNote";
import type { SummaryTone } from "../details-builder/model";
import type { DiagDomain } from "../types";
import { buildHubCards, type HubCard } from "./hubCards";

const DOMAIN_ICONS: Record<DiagDomain, ComponentType<IconProps>> = {
  dc: IconGlobe,
  me: IconServer,
  security: IconShield,
  counters: IconActivity,
  connections: IconLink,
  upstreams: IconTraffic,
  nat: IconDevice,
  events: IconClock,
  // A browser window, not a second globe: ДЦ already owns IconGlobe, and
  // WEB mode is precisely the carrier that looks like ordinary web traffic.
  web: IconDesktop,
};

const TONE_CLASSES: Record<SummaryTone, string> = {
  neutral: "text-text",
  good: "text-ok",
  warn: "text-warn",
  bad: "text-error",
};

// PulseHub is /pulse — the diagnostics hub (06-ui.md §Информационная
// архитектура). Nine preview cards, each two or three numbers and a state
// pill, each one tap from its Details page. The configurable widget
// dashboard that used to live at this URL is now /overview («Сводка»), and
// the display-mode switch went with it: the hub's eight domains are fixed.
//
// The component owns only the subscriptions; what each card SAYS is
// hubCards.ts, which reads the same summary tiles and the same §14 source
// states the Details pages do.
export function PulseHub() {
  const s = useStrings();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const security = useSnapshot<SecurityTopic>("security");
  const users = useSnapshot<UsersTopic>("users");
  const web = useSnapshot<WebTopic>("web");
  // The same query key CountersPage uses, so opening the Счётчики card
  // costs no second request. No refetchInterval here: the hub is a glance,
  // and the page itself owns the polling that R4's deltas need.
  const zero = useQuery(getTelemtZeroOptions());
  // No card formats an age today, but every metric goes through the same
  // §13 formatter registry, and a `relativeAge` one would silently freeze
  // on a page that reads the clock once at mount.
  const nowMs = useNow();

  const cards = buildHubCards(
    {
      stats,
      runtime,
      upstreams,
      security,
      users,
      web,
      counters: {
        kind: "query",
        isPending: zero.isPending,
        isError: zero.isError,
        error: zero.error ?? null,
        data: zero.data,
        dataUpdatedAt: zero.dataUpdatedAt,
      },
      nowMs,
    },
    s,
  );

  return (
    // §15.4's readable measure, the same one a Details page's content column
    // uses: past ~960px the two cards stop being cards and become two very
    // wide, very empty rules across a 1920px screen.
    <div className="detail-readable flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-title font-extrabold tracking-tight text-text">{s.pulse.title}</h1>
        <p className="text-meta text-text-muted">{s.hub.lede}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {cards.map((card) => (
          <HubCardView key={card.domain} card={card} />
        ))}
      </div>
    </div>
  );
}

function HubCardView({ card }: { card: HubCard }) {
  const s = useStrings();
  const Icon = DOMAIN_ICONS[card.domain];

  return (
    <Link
      to="/pulse/diag/$domain"
      params={{ domain: card.domain }}
      data-testid={`hub-card-${card.domain}`}
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-3.5",
        "transition-colors hover:bg-surface-2",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-muted"
        >
          <Icon className="h-4 w-4" />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">
          {card.title}
        </h2>
        <IconChevronRight className="h-4 w-4 shrink-0 text-text-faint" />
      </div>

      {/* The pill shares the metrics row rather than the title row: at 360px
          a long state name («Нет в этой версии») next to the title left
          nothing for the title itself. */}
      {/* Metrics are separated by SPACE, not by a glyph: the inter-metric
          gap (gap-x-4) is wider than the label/value gap inside one metric
          (gap-1), which is what tells the eye where a pair ends. A textual
          «·» did the same job only while the row fit on one line — on wrap
          it dangled at the end of a line with nothing after it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <StatePill state={card.pill}>{card.pillLabel}</StatePill>
        {card.metrics.map((metric) => (
          <span key={metric.id} className="flex items-baseline gap-1 text-micro">
            <span className="text-text-faint">{metric.label}</span>
            <span
              className={cn("inline-flex items-baseline gap-1 font-mono tabular-nums", TONE_CLASSES[metric.tone])}
            >
              {/* §21: never colour alone — a tile that is amber or red says
                  so with a glyph and a word for a screen reader too. */}
              {(metric.tone === "warn" || metric.tone === "bad") && (
                <>
                  <span aria-hidden="true" className="inline-flex self-center text-[11px]">
                    <IconWarning />
                  </span>
                  <span className="sr-only">
                    {metric.tone === "bad" ? s.details.summary.bad : s.details.summary.warn}
                  </span>
                </>
              )}
              {metric.text}
            </span>
          </span>
        ))}
      </div>

      {card.gate && (
        <GatedNote
          variant={card.gate.variant}
          {...(card.gate.reason !== undefined ? { reason: card.gate.reason } : {})}
          {...(card.gate.hint !== undefined ? { hint: card.gate.hint } : {})}
        />
      )}
    </Link>
  );
}
