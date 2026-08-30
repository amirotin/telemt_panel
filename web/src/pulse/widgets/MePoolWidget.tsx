import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { fill, formatNumber, useStrings } from "../../i18n";
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
// Adaptive per §17: healthy is exactly that and nothing more — the reason
// line appears only when the card has stopped being «Healthy».
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
  const facts: ReactNode[] = [];
  if (view.coveragePct !== null) {
    facts.push(
      `${s.pulse.mePool.coverage} ${formatNumber(s, Math.round(view.coveragePct))} %`,
    );
  }
  if (view.rttMs !== null) {
    facts.push(`RTT ${formatNumber(s, Math.round(view.rttMs))} ${s.pulse.dc.rttUnit}`);
  }

  return (
    <>
      <p className="flex items-baseline gap-1.5">
        <span className="font-mono text-[26px] font-semibold leading-none tabular-nums text-text">
          {formatNumber(s, view.writersAlive)} / {formatNumber(s, view.writersTotal)}
        </span>
        <span className="text-meta text-text-muted">{s.pulse.mePool.writersUnit}</span>
      </p>
      {facts.length > 0 && (
        <p className="text-meta tabular-nums text-text-muted">{facts.join(" · ")}</p>
      )}
      <p className="text-micro tabular-nums text-text-faint">
        {fill(s.pulse.mePool.churn, {
          refill: formatNumber(s, view.refillInflight),
          draining: formatNumber(s, view.draining),
        })}
      </p>
      {/* §17: the card grows one line when it has something to say. */}
      {view.reason && (
        <p
          data-testid="me-reason"
          className={view.state === "fallback" ? "text-meta text-error" : "text-meta text-warn"}
        >
          {meReasonText(view.reason, s)}
        </p>
      )}
    </>
  );
}
