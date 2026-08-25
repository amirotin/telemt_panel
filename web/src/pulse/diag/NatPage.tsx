import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { natGroups } from "./nat.helpers";

export function NatPage() {
  const topic = useSnapshot<RuntimeTopic>("runtime");

  let body;
  if (!topic.data) {
    body = <Skeleton className="h-24 w-full" />;
  } else {
    const nat = resolveGated(topic.data.nat_stun);
    body =
      nat.status === "gated" ? (
        <Gated enabled={false} reason={nat.reason} hint="runtime_edge" />
      ) : (
        <KVGroupList groups={natGroups(nat.data)} />
      );
  }

  return <DiagShell title={ru.diag.domains.nat}>{body}</DiagShell>;
}
