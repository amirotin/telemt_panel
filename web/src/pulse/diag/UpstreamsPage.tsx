import { useSnapshot, useRefreshTopic } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { useStrings } from "../../i18n";
import { DiagShell } from "./DiagShell";
import { DiagTopicState } from "./DiagTopicState";
import { KVGroupList } from "./KVGroupList";
import { upstreamsGroups } from "./upstreams.helpers";
import { GatedNote } from "../GatedNote";

export function UpstreamsPage() {
  const s = useStrings();
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const refreshTopic = useRefreshTopic();

  return (
    <DiagShell title={s.diag.domains.upstreams}>
      <DiagTopicState
        data={topic.data?.upstreams}
        error={topic.error}
        stale={topic.stale}
        onRetry={() => refreshTopic("upstreams")}
      >
        {(upstreams) =>
          !upstreams.enabled ? (
            <GatedNote reason={upstreams.reason} />
          ) : (
            // upstream_quality (mini-task 2c) shares the same minimal_runtime_enabled
            // gate as data.upstreams above — passed through when present, silently
            // contributing no extra groups otherwise (upstreamsGroups' own `quality?.
            // enabled` check), never blocking the page.
            <KVGroupList groups={upstreamsGroups(upstreams, s, runtime.data?.upstream_quality ?? undefined)} />
          )
        }
      </DiagTopicState>
    </DiagShell>
  );
}
