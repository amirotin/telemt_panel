import { useSnapshot } from "../../realtime";
import type { UpstreamsTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { computeDc, dcCoverageState } from "./dc.helpers";

export function DcWidget({ onHide }: { onHide?: () => void }) {
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const view = computeDc(topic.data?.dcs ?? null);

  return (
    <WidgetFrame title={ru.pulse.widgets.dc} diagDomain="dc" onHide={onHide} stale={topic.stale}>
      {view.status === "loading" && <Skeleton className="h-16 w-full" />}
      {view.status === "disabled" && <Gated enabled={false} reason={view.reason} />}
      {view.status === "ok" && view.dcs.length === 0 && (
        <EmptyState title={ru.pulse.dc.empty} />
      )}
      {view.status === "ok" && view.dcs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="py-1.5 pr-3 font-medium">{ru.pulse.dc.dc}</th>
                <th className="py-1.5 pr-3 font-medium">{ru.pulse.dc.coverage}</th>
                <th className="py-1.5 pr-3 font-medium">{ru.pulse.dc.writers}</th>
                <th className="py-1.5 font-medium">{ru.pulse.dc.load}</th>
              </tr>
            </thead>
            <tbody>
              {view.dcs.map((dc) => (
                <tr key={dc.dc} className="border-b border-border last:border-b-0">
                  <td className="py-1.5 pr-3 tabular-nums text-text">{dc.dc}</td>
                  <td className="py-1.5 pr-3">
                    <StatePill state={dcCoverageState(dc)}>{dc.coverage_pct.toFixed(0)}%</StatePill>
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-text-muted">
                    {dc.alive_writers}/{dc.required_writers}
                  </td>
                  <td className="py-1.5 tabular-nums text-text-muted">{dc.load}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WidgetFrame>
  );
}
