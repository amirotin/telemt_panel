import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { StatePill } from "../../ui/StatePill";
import { KVRow } from "../../ui/KVRow";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { useDisplayMode, visibleFor } from "../../display-mode";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
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

  return (
    <WidgetFrame title={ru.pulse.widgets.upstreams} diagDomain="upstreams" onHide={onHide} stale={topic.stale}>
      {view.status === "loading" && <Skeleton className="h-16 w-full" />}
      {view.status === "disabled" && <Gated enabled={false} reason={view.reason} />}
      {view.status === "ok" && view.upstreams.length === 0 && (
        <EmptyState title={ru.pulse.upstreams.empty} />
      )}
      {view.status === "ok" && view.upstreams.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="py-1.5 pr-3 font-medium">{ru.pulse.upstreams.route}</th>
                <th className="py-1.5 pr-3 font-medium">{ru.pulse.upstreams.address}</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {view.upstreams.map((u) => (
                <tr key={u.upstream_id} className="border-b border-border last:border-b-0">
                  <td className="py-1.5 pr-3 text-text">{u.route_kind}</td>
                  <td className="py-1.5 pr-3 truncate font-mono text-xs text-text-muted">{u.address}</td>
                  <td className="py-1.5">
                    <StatePill state={u.healthy ? "ok" : "error"}>
                      {u.healthy ? ru.pulse.upstreams.healthy : ru.pulse.upstreams.unhealthy}
                    </StatePill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {successRate !== null && (
        <KVRow label={ru.pulse.upstreams.successRate} value={`${successRate}%`} />
      )}
    </WidgetFrame>
  );
}
