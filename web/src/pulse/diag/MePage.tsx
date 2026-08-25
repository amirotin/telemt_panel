import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { meGroups } from "./me.helpers";

export function MePage() {
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");

  let body;
  if (!runtime.data) {
    body = <Skeleton className="h-24 w-full" />;
  } else {
    const pool = resolveGated(runtime.data.me_pool_state);
    const quality = resolveGated(runtime.data.me_quality);
    const selftest = resolveGated(runtime.data.me_selftest);
    const allGated = pool.status === "gated" && quality.status === "gated" && selftest.status === "gated";

    const groups = meGroups({
      pool: pool.status === "ok" ? pool.data : undefined,
      quality: quality.status === "ok" ? quality.data : undefined,
      selftest: selftest.status === "ok" ? selftest.data : undefined,
      meWriters: upstreams.data?.me_writers ?? undefined,
      gates: runtime.data.gates ?? undefined,
      initialization: runtime.data.initialization ?? undefined,
    });

    body = (
      <div className="flex flex-col gap-4">
        {allGated && <Gated enabled={false} reason={pool.reason} hint="runtime_edge" />}
        <KVGroupList groups={groups} />
      </div>
    );
  }

  return <DiagShell title={ru.diag.domains.me}>{body}</DiagShell>;
}
