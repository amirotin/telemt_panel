import type { ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { KVRow } from "../../ui/KVRow";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { useStrings } from "../../i18n";
import { WidgetFrame } from "../WidgetFrame";
import { resolveGated } from "./gated";
import { computeSelftestView, selftestPillState } from "./selftest.helpers";
import { GatedNote } from "../GatedNote";

export function SelftestWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<RuntimeTopic>("runtime");

  if (!topic.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.selftest} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const selftest = resolveGated(topic.data.me_selftest);
  let body: ReactNode;
  if (selftest.status === "gated") {
    body = <GatedNote reason={selftest.reason} hint="runtime_edge" />;
  } else {
    const view = computeSelftestView(selftest.data);
    body = (
      <div className="flex flex-col">
        <KVRow
          label={s.pulse.selftest.kdf}
          value={<StatePill state={selftestPillState(view.kdfState)}>{view.kdfState}</StatePill>}
        />
        <KVRow
          label={s.pulse.selftest.timeskew}
          value={
            <StatePill state={selftestPillState(view.timeskewState)}>
              {view.maxSkewSecs15m !== null ? `${view.maxSkewSecs15m}${s.pulse.selftest.secondsSuffix}` : view.timeskewState}
            </StatePill>
          }
        />
        <KVRow
          label={s.pulse.selftest.pid}
          value={<StatePill state={selftestPillState(view.pidState)}>{view.pidState}</StatePill>}
        />
      </div>
    );
  }

  return (
    <WidgetFrame title={s.pulse.widgets.selftest} diagDomain="me" onHide={onHide} stale={topic.stale}>
      {body}
    </WidgetFrame>
  );
}
