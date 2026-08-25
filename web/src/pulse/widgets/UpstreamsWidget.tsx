import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { useDisplayMode, visibleFor } from "../../display-mode";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import { computeUpstreams, upstreamQualitySuccessRate } from "./upstreams.helpers";

export function UpstreamsWidget({ onHide }: { onHide?: () => void }) {
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const { mode } = useDisplayMode();
  const view = computeUpstreams(topic.data?.upstreams ?? null);
  // upstream_quality (mini-task 2c) has no widget of its own — this is its
  // one natural compact form, shown only in extended mode, only when it has
  // ever attempted a connect (upstreamQualitySuccessRate's own null guard).
  const successRate = visibleFor("extended", mode)
    ? upstreamQualitySuccessRate(runtime.data?.upstream_quality)
    : null;
  const unhealthy =
    view.status === "ok" ? view.upstreams.filter((u) => !u.healthy).length : 0;

  return (
    <WidgetFrame
      title={ru.pulse.widgets.upstreams}
      diagDomain="upstreams"
      onHide={onHide}
      stale={topic.stale}
      badge={unhealthy > 0 ? <StatePill state="error">{unhealthy}</StatePill> : undefined}
    >
      {view.status === "loading" && <Skeleton className="h-16 w-full" />}
      {view.status === "disabled" && <GatedNote reason={view.reason} />}
      {view.status === "ok" && view.upstreams.length === 0 && (
        <EmptyState title={ru.pulse.upstreams.empty} />
      )}
      {view.status === "ok" && view.upstreams.length > 0 && (
        // The prototype's upstream line: name on the left in the muted
        // weight, the figure in tabular mono, a state pill closing the row.
        <ul className="flex flex-col gap-2">
          {view.upstreams.map((u) => (
            <li key={u.upstream_id} className="flex items-center gap-2 text-meta">
              <span className="min-w-0 shrink-0 text-text-muted">{u.route_kind}</span>
              <span className="min-w-0 flex-1 truncate text-right font-mono tabular-nums text-text">
                {u.address}
              </span>
              <StatePill state={u.healthy ? "ok" : "error"}>
                {u.healthy ? ru.pulse.upstreams.healthy : ru.pulse.upstreams.unhealthy}
              </StatePill>
            </li>
          ))}
        </ul>
      )}
      {successRate !== null && (
        <div className="flex items-center gap-2 border-t border-border pt-2 text-meta">
          <span className="min-w-0 flex-1 text-text-muted">{ru.pulse.upstreams.successRate}</span>
          <span className="shrink-0 font-mono tabular-nums text-text">{successRate}%</span>
        </div>
      )}
    </WidgetFrame>
  );
}
