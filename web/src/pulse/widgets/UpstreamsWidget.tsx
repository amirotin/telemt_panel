import { useSnapshot } from "../../realtime";
import type { UpstreamStatus, UpstreamsTopic } from "../../realtime/topics";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { fill, formatNumber, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import {
  computeUpstreams,
  computeUpstreamsCard,
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
export function UpstreamsWidget() {
  const s = useStrings();
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const data = topic.data?.upstreams ?? null;
  const routes = data?.upstreams ?? [];
  const view = computeUpstreams(data);
  const card =
    view.status === "ok" && data !== null ? computeUpstreamsCard(view, data) : null;

  return (
    <WidgetFrame
      title={s.pulse.widgets.upstreams}
      diagDomain="upstreams"
      stale={topic.stale}
      badge={card && card.total > 0 ? <HealthPill card={card} /> : undefined}
    >
      {view.status === "loading" && <Skeleton className="h-12 w-full" />}
      {view.status === "disabled" && <GatedNote reason={view.reason} />}
      {card && card.total === 0 && <EmptyState title={s.pulse.upstreams.empty} />}
      {card && card.total > 0 && (
        <div
          data-testid="upstreams-card"
          className="flex flex-col gap-1"
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
          <div className="mt-1 flex flex-col border-t border-border pt-1.5">
            {routes.slice(0, 3).map((upstream) => (
              <UpstreamRow key={upstream.upstream_id} upstream={upstream} />
            ))}
            {routes.length > 3 && (
              <span className="pt-1 text-micro text-text-faint">
                {fill(s.pulse.upstreams.more, { count: formatNumber(s, routes.length - 3) })}
              </span>
            )}
          </div>
        </div>
      )}
    </WidgetFrame>
  );
}

function UpstreamRow({ upstream }: { upstream: UpstreamStatus }) {
  const s = useStrings();
  const latency =
    upstream.effective_latency_ms === null
      ? "—"
      : `${formatNumber(s, Math.round(upstream.effective_latency_ms))} ${s.pulse.dc.rttUnit}`;
  return (
    <span className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 py-1 text-micro">
      <span className={cn("h-1.5 w-1.5 rounded-full", upstream.healthy ? "bg-ok" : "bg-error")} />
      <span className="min-w-0 truncate text-text-muted">
        <span className="font-semibold uppercase text-text">{upstream.route_kind}</span>
        {upstream.scopes && ` · ${upstream.scopes}`}
        {` · ${fill(s.pulse.upstreams.checkedAgo, { seconds: formatNumber(s, upstream.last_check_age_secs) })}`}
      </span>
      <span className="font-mono tabular-nums text-text">{latency}</span>
    </span>
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
