import { useSnapshot, useRefreshTopic } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { useStrings } from "../../i18n";
import { DiagShell } from "./DiagShell";
import { DiagTopicState } from "./DiagTopicState";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { dcGroups } from "./dc.helpers";
import { GatedNote } from "../GatedNote";

export function DcPage() {
  const s = useStrings();
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const refreshTopic = useRefreshTopic();

  return (
    <DiagShell title={s.diag.domains.dc}>
      <DiagTopicState data={topic.data?.dcs} error={topic.error} stale={topic.stale} onRetry={() => refreshTopic("upstreams")}>
        {(dcs) => {
          if (!dcs.middle_proxy_enabled) {
            return <GatedNote reason={dcs.reason} />;
          }
          // network_path (mini-task 2c) comes from a separately-gated payload
          // (minimal_runtime_enabled, extended mode) — merged in per-DC when
          // available, silently omitted (not blocking the page) when gated off.
          const minimal = runtime.data ? resolveGated(runtime.data.minimal) : null;
          const networkPaths = minimal?.status === "ok" ? minimal.data.network_path : [];
          return <KVGroupList groups={dcGroups(dcs.dcs, s, networkPaths)} />;
        }}
      </DiagTopicState>
    </DiagShell>
  );
}
