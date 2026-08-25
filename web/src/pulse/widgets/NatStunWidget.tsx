import type { ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { KVRow } from "../../ui/KVRow";
import { Skeleton } from "../../ui/Skeleton";
import { useStrings } from "../../i18n";
import { WidgetFrame } from "../WidgetFrame";
import { resolveGated } from "./gated";
import { computeNatStunView } from "./natStun.helpers";
import { GatedNote } from "../GatedNote";

export function NatStunWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<RuntimeTopic>("runtime");

  if (!topic.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.nat_stun} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const nat = resolveGated(topic.data.nat_stun);
  let body: ReactNode;
  if (nat.status === "gated") {
    body = <GatedNote reason={nat.reason} hint="runtime_edge" />;
  } else {
    const view = computeNatStunView(nat.data);
    body = (
      <div className="flex flex-col">
        <KVRow label={s.pulse.natStun.probeEnabled} value={view.probeEnabled ? s.common.yes : s.common.no} />
        <KVRow
          label={s.pulse.natStun.liveServers}
          value={`${view.liveServers}/${view.configuredServers}`}
        />
        <KVRow label={s.pulse.natStun.v4} value={view.v4Addr ?? s.pulse.natStun.noReflection} />
        <KVRow label={s.pulse.natStun.v6} value={view.v6Addr ?? s.pulse.natStun.noReflection} />
      </div>
    );
  }

  return (
    <WidgetFrame title={s.pulse.widgets.nat_stun} diagDomain="nat" onHide={onHide} stale={topic.stale}>
      {body}
    </WidgetFrame>
  );
}
