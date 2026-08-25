import type { ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { KVRow } from "../../ui/KVRow";
import { Skeleton } from "../../ui/Skeleton";
import { useStrings } from "../../i18n";
import { WidgetFrame } from "../WidgetFrame";
import { resolveGated } from "./gated";
import { computeMePoolView } from "./mePool.helpers";
import { GatedNote } from "../GatedNote";

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
  let body: ReactNode;
  if (pool.status === "gated") {
    body = <GatedNote reason={pool.reason} hint="runtime_edge" />;
  } else {
    const quality = resolveGated(topic.data.me_quality);
    const view = computeMePoolView(pool.data, quality.status === "ok" ? quality.data : undefined);
    body = (
      <div className="flex flex-col">
        <KVRow label={s.pulse.mePool.writersTotal} value={view.writersTotal} />
        <KVRow label={s.pulse.mePool.writersAlive} value={view.writersAlive} />
        <KVRow label={s.pulse.mePool.writersDraining} value={view.writersDraining} />
        <KVRow label={s.pulse.mePool.hardswapPending} value={view.hardswapPending ? s.common.yes : s.common.no} />
        {view.reconnectSuccessTotal !== undefined && view.reconnectAttemptTotal !== undefined && (
          <KVRow
            label={s.pulse.mePool.reconnects}
            value={`${view.reconnectSuccessTotal}/${view.reconnectAttemptTotal}`}
          />
        )}
      </div>
    );
  }

  return (
    <WidgetFrame title={s.pulse.widgets.me_pool} diagDomain="me" onHide={onHide} stale={topic.stale}>
      {body}
    </WidgetFrame>
  );
}
