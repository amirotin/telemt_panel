import { useSnapshot } from "../../realtime";
import type { UpstreamsTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { dcGroups } from "./dc.helpers";

export function DcPage() {
  const topic = useSnapshot<UpstreamsTopic>("upstreams");

  let body;
  if (!topic.data?.dcs) {
    body = <Skeleton className="h-24 w-full" />;
  } else if (!topic.data.dcs.middle_proxy_enabled) {
    body = <Gated enabled={false} reason={topic.data.dcs.reason} />;
  } else {
    body = <KVGroupList groups={dcGroups(topic.data.dcs.dcs)} />;
  }

  return <DiagShell title={ru.diag.domains.dc}>{body}</DiagShell>;
}
