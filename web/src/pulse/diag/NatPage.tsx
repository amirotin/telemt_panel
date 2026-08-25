import { useSnapshot, useRefreshTopic } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { DiagTopicState } from "./DiagTopicState";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { natGroups } from "./nat.helpers";
import { GatedNote } from "../GatedNote";

export function NatPage() {
  const topic = useSnapshot<RuntimeTopic>("runtime");
  const refreshTopic = useRefreshTopic();

  return (
    <DiagShell title={ru.diag.domains.nat}>
      <DiagTopicState data={topic.data} error={topic.error} stale={topic.stale} onRetry={() => refreshTopic("runtime")}>
        {(data) => {
          const nat = resolveGated(data.nat_stun);
          return nat.status === "gated" ? (
            <GatedNote reason={nat.reason} hint="runtime_edge" />
          ) : (
            <KVGroupList groups={natGroups(nat.data)} />
          );
        }}
      </DiagTopicState>
    </DiagShell>
  );
}
