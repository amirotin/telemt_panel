import { useSnapshot, useRefreshTopic } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { ru } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { DiagTopicState } from "./DiagTopicState";
import { KVGroupList } from "./KVGroupList";
import { resolveGated } from "../widgets/gated";
import { meGroups } from "./me.helpers";
import { GatedNote } from "../GatedNote";

export function MePage() {
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const refreshTopic = useRefreshTopic();

  return (
    <DiagShell title={ru.diag.domains.me}>
      <DiagTopicState
        data={runtime.data}
        error={runtime.error}
        stale={runtime.stale}
        onRetry={() => refreshTopic("runtime")}
      >
        {(data) => {
          const pool = resolveGated(data.me_pool_state);
          const quality = resolveGated(data.me_quality);
          const selftest = resolveGated(data.me_selftest);
          const minimal = resolveGated(data.minimal);
          const allRuntimeEdgeGated =
            pool.status === "gated" && quality.status === "gated" && selftest.status === "gated";

          const groups = meGroups({
            pool: pool.status === "ok" ? pool.data : undefined,
            quality: quality.status === "ok" ? quality.data : undefined,
            selftest: selftest.status === "ok" ? selftest.data : undefined,
            meWriters: upstreams.data?.me_writers ?? undefined,
            gates: data.gates ?? undefined,
            initialization: data.initialization ?? undefined,
            meRuntime: minimal.status === "ok" ? minimal.data.me_runtime : undefined,
          });

          return (
            <div className="flex flex-col gap-4">
              {allRuntimeEdgeGated && <GatedNote reason={pool.reason} hint="runtime_edge" />}
              <KVGroupList groups={groups} />
              {/* minimal is gated separately (minimal_runtime_enabled), independent of
                  runtime_edge above — its tuning-fields group simply doesn't appear in
                  `groups` when off, so this note explains the specific gap rather than
                  leaving it silently absent. */}
              {minimal.status === "gated" && (
                <GatedNote reason={minimal.reason} hint="minimal_runtime_enabled" />
              )}
            </div>
          );
        }}
      </DiagTopicState>
    </DiagShell>
  );
}
