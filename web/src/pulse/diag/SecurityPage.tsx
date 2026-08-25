import { useSnapshot, useRefreshTopic } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { DiagTopicState } from "./DiagTopicState";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { securityGroups } from "./security.helpers";

export function SecurityPage() {
  const topic = useSnapshot<SecurityTopic>("security");
  const refreshTopic = useRefreshTopic();

  return (
    <DiagShell title={ru.diag.domains.security}>
      <DiagTopicState
        data={topic.data}
        error={topic.error}
        stale={topic.stale}
        onRetry={() => refreshTopic("security")}
      >
        {(data) => {
          const tls = resolveGated(data.tls_fingerprints);
          return (
            <KVGroupList
              groups={securityGroups({
                posture: data.posture ?? undefined,
                whitelist: data.whitelist ?? undefined,
                effectiveLimits: data.effective_limits ?? undefined,
                tlsFingerprints: tls.status === "ok" ? tls.data : undefined,
              })}
            />
          );
        }}
      </DiagTopicState>
    </DiagShell>
  );
}
