import { useSnapshot } from "../../realtime";
import type { RuntimeMePoolState, RuntimeMeQuality, RuntimeTopic } from "../../realtime/topics";
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
// latency on one line, and the current conclusion below it. Refill/drain
// internals remain on /pulse/diag/me; squeezing them into four micro-columns
// made the Overview harder to scan without changing an operator's decision.
export function MePoolWidget() {
  const s = useStrings();
  const topic = useSnapshot<RuntimeTopic>("runtime");

  if (!topic.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.me_pool} diagDomain="me">
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const pool = resolveGated(topic.data.me_pool_state);
  if (pool.status === "gated") {
    return (
      <WidgetFrame title={s.pulse.widgets.me_pool} diagDomain="me" stale={topic.stale}>
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
      diagDomain="me"
      stale={topic.stale}
      badge={<StatePill state={view.tone}>{s.pulse.mePool.state[view.state]}</StatePill>}
    >
      <div
        data-testid="me-card"
        className="flex flex-col gap-1"
      >
        <MeBody
          view={view}
          pool={pool.data}
          quality={quality.status === "ok" ? quality.data : undefined}
        />
      </div>
    </WidgetFrame>
  );
}

function MeBody({
  view,
  pool,
  quality,
}: {
  view: MeCardView;
  pool: RuntimeMePoolState;
  quality?: RuntimeMeQuality;
}) {
  const s = useStrings();
  const dash = "—";
  const required = quality?.dc_rtt.reduce((sum, dc) => sum + dc.required_writers, 0) ?? null;
  const families = quality?.family_states ?? [];

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
          <span className="shrink-0 font-mono text-[26px] font-semibold leading-none tabular-nums text-text">
            {formatNumber(s, view.writersAlive)} / {formatNumber(s, required ?? view.writersTotal)}
          </span>
          <span className="min-w-0 truncate text-meta text-text-muted">
            {required === null ? s.pulse.mePool.writersUnit : s.pulse.mePool.availableRequired}
          </span>
        </p>
        <p className="ml-auto truncate text-meta tabular-nums text-text-muted" data-testid="me-quality">
          {s.pulse.mePool.coverage}{" "}
          {view.coveragePct === null ? dash : `${formatNumber(s, Math.round(view.coveragePct))} %`}
          {" · RTT "}
          {view.rttMs === null
            ? dash
            : `${formatNumber(s, Math.round(view.rttMs))} ${s.pulse.dc.rttUnit}`}
        </p>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        <PoolFact label={s.pulse.mePool.healthy} value={pool.writers.health.healthy} tone="ok" />
        <PoolFact label={s.pulse.mePool.degraded} value={view.degraded} tone={view.degraded > 0 ? "warn" : "muted"} />
        <PoolFact label={s.pulse.mePool.draining} value={view.draining} tone={view.draining > 0 ? "warn" : "muted"} />
        <PoolFact label={s.pulse.mePool.refill} value={view.refillInflight} tone={view.refillInflight > 0 ? "warn" : "muted"} />
      </div>
      {families.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {families.map((family) => (
            <span
              key={family.family}
              className={cn(
                "rounded-full bg-surface-2 px-2 py-0.5 text-micro",
                family.state === "healthy" ? "text-ok" : "text-warn",
              )}
            >
              {family.family.toUpperCase()} · {family.state}
            </span>
          ))}
        </div>
      )}
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

function PoolFact({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" | "muted" }) {
  return (
    <span className="min-w-0 rounded-md bg-surface-2 px-1.5 py-1.5 text-center">
      <span className={cn("block font-mono text-row font-semibold tabular-nums", tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-text")}>{value}</span>
      <span className="mt-0.5 block truncate text-[9px] uppercase tracking-[0.03em] text-text-faint">{label}</span>
    </span>
  );
}
