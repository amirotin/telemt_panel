import { useSnapshot, useRefreshTopic } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { useStrings } from "../../i18n";
import { DiagShell } from "./DiagShell";
import { DiagTopicState } from "./DiagTopicState";
import { KVGroupList } from "./KVGroupList";
import { TlsSourceNotice } from "../widgets/TlsSourceNotice";
import { useTlsFingerprints } from "../widgets/useTlsFingerprints";
import { securityGroups } from "./security.helpers";

export function SecurityPage() {
  const s = useStrings();
  const topic = useSnapshot<SecurityTopic>("security");
  const refreshTopic = useRefreshTopic();
  // TLS fingerprints left the `security` topic in M4 task 1 (~120 KB per
  // poll) — the page fetches them itself; posture/whitelist/limits still
  // come from the topic, so the two sources render independently and one
  // being gated never blanks the other.
  const tls = useTlsFingerprints();

  return (
    <DiagShell title={s.diag.domains.security}>
      <DiagTopicState
        data={topic.data}
        error={topic.error}
        stale={topic.stale}
        onRetry={() => refreshTopic("security")}
      >
        {(data) => (
          <>
            <KVGroupList
              groups={securityGroups({
                posture: data.posture ?? undefined,
                whitelist: data.whitelist ?? undefined,
                effectiveLimits: data.effective_limits ?? undefined,
                tlsFingerprints: tls.status === "ok" ? tls.data : undefined,
              }, s)}
            />
            <TlsSourceNotice state={tls} as="note" />
          </>
        )}
      </DiagTopicState>
    </DiagShell>
  );
}
