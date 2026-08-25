import { useSnapshot } from "../../realtime";
import type { UpstreamsTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { upstreamsGroups } from "./upstreams.helpers";

export function UpstreamsPage() {
  const topic = useSnapshot<UpstreamsTopic>("upstreams");

  let body;
  if (!topic.data?.upstreams) {
    body = <Skeleton className="h-24 w-full" />;
  } else if (!topic.data.upstreams.enabled) {
    body = <Gated enabled={false} reason={topic.data.upstreams.reason} />;
  } else {
    body = <KVGroupList groups={upstreamsGroups(topic.data.upstreams)} />;
  }

  return <DiagShell title={ru.diag.domains.upstreams}>{body}</DiagShell>;
}
