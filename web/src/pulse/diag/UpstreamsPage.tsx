import { useSnapshot, useRefreshTopic } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { DiagTopicState } from "./DiagTopicState";
import { KVGroupList } from "./KVGroupList";
import { upstreamsGroups } from "./upstreams.helpers";

export function UpstreamsPage() {
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const refreshTopic = useRefreshTopic();

  return (
    <DiagShell title={ru.diag.domains.upstreams}>
      <DiagTopicState
        data={topic.data?.upstreams}
        error={topic.error}
        stale={topic.stale}
        onRetry={() => refreshTopic("upstreams")}
      >
        {(upstreams) =>
          !upstreams.enabled ? (
            <Gated enabled={false} reason={upstreams.reason} />
          ) : (
            // upstream_quality (mini-task 2c) shares the same minimal_runtime_enabled
            // gate as data.upstreams above — passed through when present, silently
            // contributing no extra groups otherwise (upstreamsGroups' own `quality?.
            // enabled` check), never blocking the page.
            <KVGroupList groups={upstreamsGroups(upstreams, runtime.data?.upstream_quality ?? undefined)} />
          )
        }
      </DiagTopicState>
    </DiagShell>
  );
}
