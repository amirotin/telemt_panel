import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { upstreamsGroups } from "./upstreams.helpers";

export function UpstreamsPage() {
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");

  let body;
  if (!topic.data?.upstreams) {
    body = <Skeleton className="h-24 w-full" />;
  } else if (!topic.data.upstreams.enabled) {
    body = <Gated enabled={false} reason={topic.data.upstreams.reason} />;
  } else {
    // upstream_quality (mini-task 2c) shares the same minimal_runtime_enabled
    // gate as data.upstreams above — passed through when present, silently
    // contributing no extra groups otherwise (upstreamsGroups' own `quality?.
    // enabled` check), never blocking the page.
    body = (
      <KVGroupList groups={upstreamsGroups(topic.data.upstreams, runtime.data?.upstream_quality ?? undefined)} />
    );
  }

  return <DiagShell title={ru.diag.domains.upstreams}>{body}</DiagShell>;
}
