import type { ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { KVRow } from "../../ui/KVRow";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { resolveGated } from "./gated";
import { computeMePoolView } from "./mePool.helpers";

export function MePoolWidget({ onHide }: { onHide?: () => void }) {
  const topic = useSnapshot<RuntimeTopic>("runtime");

  if (!topic.data) {
    return (
      <WidgetFrame title={ru.pulse.widgets.me_pool} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const pool = resolveGated(topic.data.me_pool_state);
  let body: ReactNode;
  if (pool.status === "gated") {
    body = <Gated enabled={false} reason={pool.reason} hint="runtime_edge" />;
  } else {
    const quality = resolveGated(topic.data.me_quality);
    const view = computeMePoolView(pool.data, quality.status === "ok" ? quality.data : undefined);
    body = (
      <div className="flex flex-col">
        <KVRow label={ru.pulse.mePool.writersTotal} value={view.writersTotal} />
        <KVRow label={ru.pulse.mePool.writersAlive} value={view.writersAlive} />
        <KVRow label={ru.pulse.mePool.writersDraining} value={view.writersDraining} />
        <KVRow label={ru.pulse.mePool.hardswapPending} value={view.hardswapPending ? ru.common.yes : ru.common.no} />
        {view.reconnectSuccessTotal !== undefined && view.reconnectAttemptTotal !== undefined && (
          <KVRow
            label={ru.pulse.mePool.reconnects}
            value={`${view.reconnectSuccessTotal}/${view.reconnectAttemptTotal}`}
          />
        )}
      </div>
    );
  }

  return (
    <WidgetFrame title={ru.pulse.widgets.me_pool} diagDomain="me" onHide={onHide} stale={topic.stale}>
      {body}
    </WidgetFrame>
  );
}
