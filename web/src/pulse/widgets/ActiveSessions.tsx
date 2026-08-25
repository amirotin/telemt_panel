import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import { KVRow } from "../../ui/KVRow";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { computeActiveSessions } from "./activeSessions.helpers";
import { GatedNote } from "../GatedNote";

export function ActiveSessions({ onHide }: { onHide?: () => void }) {
  const stats = useSnapshot<StatsSnapshot>("stats");
  const view = computeActiveSessions(stats.data);

  return (
    <WidgetFrame
      title={ru.pulse.widgets.active_sessions}
      diagDomain="connections"
      onHide={onHide}
      stale={stats.stale}
    >
      {view.status === "loading" && <Skeleton className="h-16 w-full" />}
      {view.status === "gated" && (
        <GatedNote reason={view.reason} hint="runtime_edge" />
      )}
      {view.status === "ok" && (
        <div className="flex flex-col">
          <KVRow label={ru.pulse.activeSessions.current} value={view.current} />
          <KVRow label={ru.pulse.activeSessions.viaMe} value={view.viaMe} />
          <KVRow label={ru.pulse.activeSessions.direct} value={view.direct} />
          <KVRow label={ru.pulse.activeSessions.activeUsers} value={view.activeUsers} />
        </div>
      )}
    </WidgetFrame>
  );
}
