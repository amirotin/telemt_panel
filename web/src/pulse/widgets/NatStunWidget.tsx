import type { ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { KVRow } from "../../ui/KVRow";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { resolveGated } from "./gated";
import { computeNatStunView } from "./natStun.helpers";

export function NatStunWidget({ onHide }: { onHide?: () => void }) {
  const topic = useSnapshot<RuntimeTopic>("runtime");

  if (!topic.data) {
    return (
      <WidgetFrame title={ru.pulse.widgets.nat_stun} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const nat = resolveGated(topic.data.nat_stun);
  let body: ReactNode;
  if (nat.status === "gated") {
    body = <Gated enabled={false} reason={nat.reason} hint="runtime_edge" />;
  } else {
    const view = computeNatStunView(nat.data);
    body = (
      <div className="flex flex-col">
        <KVRow label={ru.pulse.natStun.probeEnabled} value={view.probeEnabled ? ru.common.yes : ru.common.no} />
        <KVRow
          label={ru.pulse.natStun.liveServers}
          value={`${view.liveServers}/${view.configuredServers}`}
        />
        <KVRow label={ru.pulse.natStun.v4} value={view.v4Addr ?? ru.pulse.natStun.noReflection} />
        <KVRow label={ru.pulse.natStun.v6} value={view.v6Addr ?? ru.pulse.natStun.noReflection} />
      </div>
    );
  }

  return (
    <WidgetFrame title={ru.pulse.widgets.nat_stun} diagDomain="nat" onHide={onHide} stale={topic.stale}>
      {body}
    </WidgetFrame>
  );
}
