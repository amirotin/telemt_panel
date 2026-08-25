import { useSnapshot } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { securityGroups } from "./security.helpers";

export function SecurityPage() {
  const topic = useSnapshot<SecurityTopic>("security");

  let body;
  if (!topic.data) {
    body = <Skeleton className="h-24 w-full" />;
  } else {
    const tls = resolveGated(topic.data.tls_fingerprints);
    body = (
      <KVGroupList
        groups={securityGroups({
          posture: topic.data.posture ?? undefined,
          whitelist: topic.data.whitelist ?? undefined,
          effectiveLimits: topic.data.effective_limits ?? undefined,
          tlsFingerprints: tls.status === "ok" ? tls.data : undefined,
        })}
      />
    );
  }

  return <DiagShell title={ru.diag.domains.security}>{body}</DiagShell>;
}
