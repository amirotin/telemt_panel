import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import { Gated } from "../../caps";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { connectionsGroups, summaryGroup } from "./connections.helpers";

// ConnectionsPage: the always-on stats.summary scalars (Сводка) render
// first regardless of gate state, so the page stays useful even when
// connections_summary itself is gated off — only the runtime-edge-gated
// connections_summary groups fall back to the Gated block below it.
export function ConnectionsPage() {
  const stats = useSnapshot<StatsSnapshot>("stats");

  let body;
  if (!stats.data) {
    body = <Skeleton className="h-24 w-full" />;
  } else {
    const result = resolveGated(stats.data.connections_summary);
    body = (
      <>
        <KVGroupList groups={summaryGroup(stats.data.summary)} />
        {result.status === "gated" ? (
          <Gated enabled={false} reason={result.reason} hint="runtime_edge" className="mt-4" />
        ) : (
          <div className="mt-4">
            <KVGroupList groups={connectionsGroups(result.data)} />
          </div>
        )}
      </>
    );
  }

  return <DiagShell title={ru.diag.domains.connections}>{body}</DiagShell>;
}
