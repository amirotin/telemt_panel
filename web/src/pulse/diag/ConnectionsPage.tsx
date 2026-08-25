import { useSnapshot, useRefreshTopic } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { DiagTopicState } from "./DiagTopicState";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { connectionsGroups, summaryGroup } from "./connections.helpers";
import { GatedNote } from "../GatedNote";

// ConnectionsPage: the always-on stats.summary scalars (Сводка) render
// first regardless of gate state, so the page stays useful even when
// connections_summary itself is gated off — only the runtime-edge-gated
// connections_summary groups fall back to the Gated block below it.
export function ConnectionsPage() {
  const stats = useSnapshot<StatsSnapshot>("stats");
  const refreshTopic = useRefreshTopic();

  return (
    <DiagShell title={ru.diag.domains.connections}>
      <DiagTopicState data={stats.data} error={stats.error} stale={stats.stale} onRetry={() => refreshTopic("stats")}>
        {(data) => {
          const result = resolveGated(data.connections_summary);
          return (
            <>
              <KVGroupList groups={summaryGroup(data.summary)} />
              {result.status === "gated" ? (
                <GatedNote reason={result.reason} hint="runtime_edge" className="mt-4" />
              ) : (
                <div className="mt-4">
                  <KVGroupList groups={connectionsGroups(result.data)} />
                </div>
              )}
            </>
          );
        }}
      </DiagTopicState>
    </DiagShell>
  );
}
