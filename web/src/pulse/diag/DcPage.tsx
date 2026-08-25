import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { dcGroups } from "./dc.helpers";

export function DcPage() {
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");

  let body;
  if (!topic.data?.dcs) {
    body = <Skeleton className="h-24 w-full" />;
  } else if (!topic.data.dcs.middle_proxy_enabled) {
    body = <Gated enabled={false} reason={topic.data.dcs.reason} />;
  } else {
    // network_path (mini-task 2c) comes from a separately-gated payload
    // (minimal_runtime_enabled, extended mode) — merged in per-DC when
    // available, silently omitted (not blocking the page) when gated off.
    const minimal = runtime.data ? resolveGated(runtime.data.minimal) : null;
    const networkPaths = minimal?.status === "ok" ? minimal.data.network_path : [];
    body = <KVGroupList groups={dcGroups(topic.data.dcs.dcs, networkPaths)} />;
  }

  return <DiagShell title={ru.diag.domains.dc}>{body}</DiagShell>;
}
