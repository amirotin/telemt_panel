import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import { Gated } from "../../caps";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { connectionsGroups } from "./connections.helpers";

export function ConnectionsPage() {
  const stats = useSnapshot<StatsSnapshot>("stats");

  let body;
  if (!stats.data) {
    body = <Skeleton className="h-24 w-full" />;
  } else {
    const result = resolveGated(stats.data.connections_summary);
    body =
      result.status === "gated" ? (
        <Gated enabled={false} reason={result.reason} hint="runtime_edge" />
      ) : (
        <KVGroupList groups={connectionsGroups(result.data)} />
      );
  }

  return <DiagShell title={ru.diag.domains.connections}>{body}</DiagShell>;
}
