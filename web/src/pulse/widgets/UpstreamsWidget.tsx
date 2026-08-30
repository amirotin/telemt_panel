import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { useDisplayMode, visibleFor } from "../../display-mode";
import { fill, formatNumber, useStrings } from "../../i18n";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import {
  computeUpstreams,
  computeUpstreamsCard,
  upstreamQualitySuccessRate,
  type UpstreamsCardView,
} from "./upstreams.helpers";

// UpstreamsWidget — «Апстримы» as concept §12's adaptive card, third in
// §13's infrastructure stack.
//
// It used to be a list: one row per configured route, name, address and a
// state pill. On every install this panel has met that list is exactly one
// row long and it reads «direct · direct · Здоров» — three words for one
// fact. §12 asks for the opposite discipline: say the configuration the
// operator HAS, and let the card grow if they ever build a bigger one.
//
// So a direct-only fleet is «● Direct · В норме · 103 мс», and a mixed one
// is «● 3 / 3 · Direct · SOCKS5 ×2 · 32 мс в среднем» — the same card, the
// same payload, no second layout held open for a configuration that may
// never exist.
export function UpstreamsWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const { mode } = useDisplayMode();
  const data = topic.data?.upstreams ?? null;
  const view = computeUpstreams(data);
  // upstream_quality (mini-task 2c) has no widget of its own — this is its
  // one natural compact form, shown only in extended mode, only when it has
  // ever attempted a connect (upstreamQualitySuccessRate's own null guard).
  const successRate = visibleFor("extended", mode)
    ? upstreamQualitySuccessRate(runtime.data?.upstream_quality)
    : null;
  const card =
    view.status === "ok" && data !== null ? computeUpstreamsCard(view, data) : null;

  return (
    <WidgetFrame
      title={s.pulse.widgets.upstreams}
      onHide={onHide}
      stale={topic.stale}
      badge={card && card.total > 0 ? <HealthPill card={card} /> : undefined}
    >
      {view.status === "loading" && <Skeleton className="h-12 w-full" />}
      {view.status === "disabled" && <GatedNote reason={view.reason} />}
      {card && card.total === 0 && <EmptyState title={s.pulse.upstreams.empty} />}
      {card && card.total > 0 && (
        // The card's body is the way into /pulse/diag/upstreams, where the
        // per-route table lives; the frame carries no second link to it.
        <Link
          to="/pulse/diag/$domain"
          params={{ domain: "upstreams" }}
          aria-label={`${s.pulse.widgets.upstreams}: ${s.pulse.diagLink}`}
          data-testid="upstreams-card"
          className="-mx-1 flex flex-col gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <p className="truncate text-meta text-text" data-testid="upstreams-kinds">
            {card.kinds
              .map((kind) => (kind.count > 1 ? `${kind.label} ×${kind.count}` : kind.label))
              .join(" · ")}
          </p>
          {card.latencyMs !== null && (
            <p className="text-micro tabular-nums text-text-muted" data-testid="upstreams-latency">
              {formatNumber(s, Math.round(card.latencyMs))} {s.pulse.dc.rttUnit}
              {!card.directOnly && ` ${s.pulse.upstreams.onAverage}`}
            </p>
          )}
        </Link>
      )}
      {successRate !== null && (
        <div className="flex items-center gap-2 border-t border-border pt-2 text-meta">
          <span className="min-w-0 flex-1 text-text-muted">{s.pulse.upstreams.successRate}</span>
          <span className="shrink-0 font-mono tabular-nums text-text">{successRate}%</span>
        </div>
      )}
    </WidgetFrame>
  );
}

// One route that works needs no arithmetic: «В норме» says it. More than
// one, and the fraction is the only honest headline — «2 / 3» is a
// different fact from «unhealthy: 1» when the third is what carries the
// traffic.
function HealthPill({ card }: { card: UpstreamsCardView }) {
  const s = useStrings();
  if (card.directOnly) {
    return (
      <StatePill state={card.tone}>
        {card.tone === "ok" ? s.pulse.upstreams.healthy : s.pulse.upstreams.unhealthy}
      </StatePill>
    );
  }
  return (
    <StatePill state={card.tone}>
      {fill(s.pulse.upstreams.healthyOf, {
        healthy: formatNumber(s, card.healthy),
        total: formatNumber(s, card.total),
      })}
    </StatePill>
  );
}
