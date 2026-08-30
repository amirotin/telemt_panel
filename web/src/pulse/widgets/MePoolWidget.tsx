import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { formatNumber, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { WidgetFrame } from "../WidgetFrame";
import { resolveGated } from "./gated";
import { computeMeCard, meReasonText, type MeCardView } from "./mePool.helpers";
import { GatedNote } from "../GatedNote";

// MePoolWidget — «ME» as concept §10's subsystem card, one third of the
// infrastructure row §13 puts ME, WEB and Апстримы on. It used to be five
// KV rows of pool internals; those belong on /pulse/diag/me («На главной
// показывать только summary»), and what is left is the summary itself: a
// state word, the writer count as the card's one large figure, coverage and
// latency on one line, pool churn on the next.
//
// The card's height is FIXED: writers, a coverage/RTT line that keeps its
// place with an em dash when ME quality is gated off, a 2×2 grid of the
// four standing pool facts, and a status line that always says something —
// the reason when unwell, «Все писатели живы» when not. §17's adaptivity is
// in the WORDS, not in the geometry: this card is the top of a column of
// three, and a line appearing here shoved WEB and Апстримы down the page
// every time the pool sneezed.
export function MePoolWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<RuntimeTopic>("runtime");

  if (!topic.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.me_pool} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const pool = resolveGated(topic.data.me_pool_state);
  if (pool.status === "gated") {
    return (
      <WidgetFrame title={s.pulse.widgets.me_pool} onHide={onHide} stale={topic.stale}>
        <GatedNote reason={pool.reason} hint="runtime_edge" />
      </WidgetFrame>
    );
  }

  const quality = resolveGated(topic.data.me_quality);
  const view = computeMeCard(
    pool.data,
    quality.status === "ok" ? quality.data : undefined,
    topic.data.gates,
  );

  return (
    <WidgetFrame
      title={s.pulse.widgets.me_pool}
      onHide={onHide}
      stale={topic.stale}
      badge={<StatePill state={view.tone}>{s.pulse.mePool.state[view.state]}</StatePill>}
    >
      {/* The card IS the way into the ME page, so the frame carries no
          second «Диагностика →» link to the same place. */}
      <Link
        to="/pulse/diag/$domain"
        params={{ domain: "me" }}
        aria-label={`${s.pulse.widgets.me_pool}: ${s.pulse.diagLink}`}
        data-testid="me-card"
        className="-mx-1 flex flex-col gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <MeBody view={view} />
      </Link>
    </WidgetFrame>
  );
}

function MeBody({ view }: { view: MeCardView }) {
  const s = useStrings();
  const dash = "—";
  const facts: Array<{ key: string; label: string; value: string }> = [
    {
      key: "refill",
      label: s.pulse.mePool.facts.refill,
      value: formatNumber(s, view.refillInflight),
    },
    { key: "draining", label: s.pulse.mePool.facts.draining, value: formatNumber(s, view.draining) },
    {
      key: "fallback",
      label: s.pulse.mePool.facts.fallback,
      value: view.fallback ? s.common.yes : s.common.no,
    },
    { key: "degraded", label: s.pulse.mePool.facts.degraded, value: formatNumber(s, view.degraded) },
  ];

  return (
    <>
      {/* Two columns from `lg:`, stacked below it: a third of the grid is
          360px on a 1440 desktop and 306 on a phone, and at 306 the writer
          count and the four facts cannot both have half of it. */}
      <div className="flex flex-col gap-1.5 lg:flex-row lg:items-start lg:gap-3">
        <div className="flex min-w-0 flex-col gap-1 lg:flex-1">
          {/* Never two lines: the figure holds its width and the unit
              truncates, because the card's height is the whole point. */}
          <p className="flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="shrink-0 font-mono text-[26px] font-semibold leading-none tabular-nums text-text">
              {formatNumber(s, view.writersAlive)} / {formatNumber(s, view.writersTotal)}
            </span>
            <span className="min-w-0 truncate text-meta text-text-muted">
              {s.pulse.mePool.writersUnit}
            </span>
          </p>
          {/* Always one line, an em dash where ME quality is gated off: the
              line disappearing took 18px out of the middle of the card. */}
          <p className="truncate text-meta tabular-nums text-text-muted" data-testid="me-quality">
            {s.pulse.mePool.coverage}{" "}
            {view.coveragePct === null ? dash : `${formatNumber(s, Math.round(view.coveragePct))} %`}
            {" · RTT "}
            {view.rttMs === null
              ? dash
              : `${formatNumber(s, Math.round(view.rttMs))} ${s.pulse.dc.rttUnit}`}
          </p>
        </div>
        {/* The four standing facts, 2×2, values always shown. They were one
            «пополнение 0 · дренаж 0» line that said half as much and left
            the card's right half empty. */}
        <dl
          data-testid="me-facts"
          className="grid grid-cols-4 gap-x-2 gap-y-0.5 lg:w-[42%] lg:shrink-0 lg:grid-cols-2"
        >
          {facts.map((fact) => (
            <div key={fact.key} className="min-w-0">
              <dt className="truncate text-[10px] leading-tight text-text-faint">{fact.label}</dt>
              <dd className="truncate font-mono text-micro tabular-nums text-text-muted">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {/* The status line is a RESERVED slot, not a line that appears: it
          says the reason when there is one and «Все писатели живы» when
          there is not, so the two cards below never move. */}
      <p
        data-testid="me-status"
        className={cn(
          "truncate text-meta",
          view.reason === null
            ? "text-text-muted"
            : view.state === "fallback"
              ? "text-error"
              : "text-warn",
        )}
      >
        {view.reason === null ? s.pulse.mePool.allAlive : meReasonText(view.reason, s)}
      </p>
    </>
  );
}
