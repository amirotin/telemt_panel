import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { errorMessage, useStrings } from "../../i18n";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { StatePill } from "../../ui/StatePill";
import { apiErrorCode } from "../../people/apiError";
import { useConnectionState, useSnapshot } from "../../realtime";
import type { UpdateTopicEvent } from "../../realtime/topics";
import {
  getHostOptions,
  getUpdatesOptions,
  getUpdatesQueryKey,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { UpdateRun } from "../../lib/api/generated/types.gen";
import { Card, CardTitle } from "../../ui/Card";
import { UpdateTarget } from "./UpdateTarget";
import { AutoUpdateForm } from "./AutoUpdateForm";
import { sortJournalDesc, updatePhaseStep } from "./updatePhase.helpers";
import { formatAuditTimestamp } from "../../journal/timestamp.helpers";

// UpdatesPage — /server/updates (06-ui.md §Обновления): both targets
// through the shared UpdateTarget component, live progress from the
// `update` SSE topic with a polling fallback whenever it isn't open
// (lock_held is the ground truth for "something is currently running" —
// simpler and just as correct as re-deriving it from two independent
// per-target signals), auto-update settings, and each target's journal.
export function UpdatesPage() {
  const s = useStrings();
  const queryClient = useQueryClient();
  const connection = useConnectionState();
  const sse = useSnapshot<UpdateTopicEvent>("update");
  const hostQuery = useQuery(getHostOptions());

  const updatesQuery = useQuery({
    ...getUpdatesOptions(),
    // The refetchInterval callback receives the query's own state directly
    // (not a closure over `updatesQuery`, which doesn't exist yet at this
    // point in the hook call) — lock_held is the ground truth for "an
    // update is currently running somewhere", and the fallback only
    // engages while the shared SSE connection isn't reporting "open"
    // (06-ui.md §Обновления: "SSE отвалился → поллинг снапшота").
    refetchInterval: (query) => {
      const hasActiveRun = Boolean(query.state.data?.lock_held);
      return hasActiveRun && connection.status !== "open" ? 3000 : false;
    },
  });

  if (updatesQuery.isPending || hostQuery.isPending) {
    return (
      <ServerShell title={s.server.updates.title}>
        <Skeleton className="h-40 w-full" />
      </ServerShell>
    );
  }

  if (updatesQuery.isError) {
    return (
      <ServerShell title={s.server.updates.title}>
        <ErrorState
          message={errorMessage(s, 
            apiErrorCode(updatesQuery.error) ?? "internal_error",
          )}
          onRetry={() => updatesQuery.refetch()}
        />
      </ServerShell>
    );
  }

  const telemt = updatesQuery.data.targets.find((t) => t.target === "telemt");
  const panel = updatesQuery.data.targets.find((t) => t.target === "panel");

  return (
    <ServerShell title={s.server.updates.title}>
      {connection.status !== "open" && (
        <StatePill state="warn">{s.server.updates.sseStale}</StatePill>
      )}

      <div className="flex flex-col gap-2.5">
        {telemt && (
          <UpdateTarget
            target="telemt"
            data={telemt}
            lockHeld={updatesQuery.data.lock_held}
            hostCaps={hostQuery.data?.caps}
            manualCommands={hostQuery.data?.manual_commands}
            sseEvent={sse.data}
            onApplied={() =>
              queryClient.invalidateQueries({ queryKey: getUpdatesQueryKey() })
            }
          />
        )}
        {panel && (
          <UpdateTarget
            target="panel"
            data={panel}
            lockHeld={updatesQuery.data.lock_held}
            hostCaps={hostQuery.data?.caps}
            manualCommands={hostQuery.data?.manual_commands}
            sseEvent={sse.data}
            onApplied={() =>
              queryClient.invalidateQueries({ queryKey: getUpdatesQueryKey() })
            }
          />
        )}
      </div>

      <AutoUpdateForm />

      <div className="flex flex-col gap-2.5">
        {telemt && (
          <JournalList
            title={s.server.updates.targetNames.telemt}
            entries={telemt.journal ?? []}
          />
        )}
        {panel && (
          <JournalList
            title={s.server.updates.targetNames.panel}
            entries={panel.journal ?? []}
          />
        )}
      </div>
    </ServerShell>
  );
}

// DOT_CLASSES maps the run's outcome (via the already-tested
// updatePhaseStep) to the prototype's 7px history dot — no second phase
// classification lives here.
const DOT_CLASSES: Record<string, string> = {
  success: "bg-ok",
  error: "bg-error",
  rolling_back: "bg-warn",
  running: "bg-accent",
};

function JournalList({
  title,
  entries,
}: {
  title: string;
  entries: UpdateRun[];
}) {
  const s = useStrings();
  const sorted = sortJournalDesc(entries);
  return (
    <Card className="flex flex-col gap-1">
      <CardTitle className="pb-1">
        {s.server.updates.journalTitle} — {title}
      </CardTitle>
      {sorted.length === 0 ? (
        <p className="py-1 text-meta text-text-faint">
          {s.server.updates.journalEmpty}
        </p>
      ) : (
        <ul className="flex flex-col">
          {sorted.map((entry, i) => (
            <li
              key={`${entry.run_id}-${entry.phase}-${i}`}
              className="flex min-h-[44px] flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-border py-2 last:border-b-0"
            >
              <span
                aria-hidden="true"
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${
                  DOT_CLASSES[updatePhaseStep(entry.phase).outcome ?? "running"]
                }`}
              />
              <span className="font-mono text-meta tabular-nums text-text">
                {entry.version_from ? `${entry.version_from} → ` : ""}
                {entry.version_to}
              </span>
              <span className="min-w-0 flex-1 truncate text-micro text-text-muted">
                {s.server.updates.phases[entry.phase]}
                {entry.detail ? ` · ${entry.detail}` : ""}
              </span>
              <span className="shrink-0 text-micro tabular-nums text-text-faint">
                {formatAuditTimestamp(entry.started_at, s)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
