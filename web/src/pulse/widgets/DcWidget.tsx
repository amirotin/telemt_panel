import { useSnapshot } from "../../realtime";
import type { UpstreamsTopic } from "../../realtime/topics";
import type { State } from "../../ui/StatePill";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import { computeDc, dcCoverageState } from "./dc.helpers";

// The prototype shows the DCs as a strip of small tinted tiles rather than
// a table — five of them fit a phone width, and the colour alone answers
// "are the datacentres up". Ours carry one line more than the prototype's
// (name / coverage) because the topic also reports writers and load, and
// dropping them would make the widget less useful than the data allows.
const TILE_TONE: Record<State, string> = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/12 text-warn",
  error: "bg-error/12 text-error",
  muted: "bg-surface-2 text-text-muted",
};

export function DcWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const view = computeDc(topic.data?.dcs ?? null);
  const okCount =
    view.status === "ok" ? view.dcs.filter((dc) => dcCoverageState(dc) === "ok").length : 0;

  return (
    <WidgetFrame
      title={s.pulse.widgets.dc}
      diagDomain="dc"
      onHide={onHide}
      stale={topic.stale}
      badge={
        view.status === "ok" && view.dcs.length > 0 ? (
          <StatePill state={okCount === view.dcs.length ? "ok" : "warn"}>
            {okCount}/{view.dcs.length}
          </StatePill>
        ) : undefined
      }
    >
      {view.status === "loading" && <Skeleton className="h-16 w-full" />}
      {view.status === "disabled" && <GatedNote reason={view.reason} />}
      {view.status === "ok" && view.dcs.length === 0 && <EmptyState title={s.pulse.dc.empty} />}
      {view.status === "ok" && view.dcs.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {view.dcs.map((dc) => {
            const state = dcCoverageState(dc);
            return (
              <li
                key={dc.dc}
                className={cn(
                  "min-w-[64px] flex-1 rounded-md px-1 py-1.5 text-center font-mono text-[11px] tabular-nums",
                  TILE_TONE[state],
                )}
              >
                <span className="block font-semibold">
                  {s.pulse.dc.dc}
                  {dc.dc}
                </span>
                <span className="block text-text-muted">{dc.coverage_pct.toFixed(0)}%</span>
                <span className="block text-[10px] text-text-muted">
                  {dc.alive_writers}/{dc.required_writers} · {dc.load}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetFrame>
  );
}
