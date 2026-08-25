import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { ru, errorMessage } from "../../i18n/ru";
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
import { UpdateTarget } from "./UpdateTarget";
import { AutoUpdateForm } from "./AutoUpdateForm";
import { sortJournalDesc } from "./updatePhase.helpers";
import { formatAuditTimestamp } from "../../journal/timestamp.helpers";

// UpdatesPage — /server/updates (06-ui.md §Обновления): both targets
// through the shared UpdateTarget component, live progress from the
// `update` SSE topic with a polling fallback whenever it isn't open
// (lock_held is the ground truth for "something is currently running" —
// simpler and just as correct as re-deriving it from two independent
// per-target signals), auto-update settings, and each target's journal.
export function UpdatesPage() {
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
      <ServerShell title={ru.server.updates.title}>
        <Skeleton className="h-40 w-full" />
      </ServerShell>
    );
  }

  if (updatesQuery.isError) {
    return (
      <ServerShell title={ru.server.updates.title}>
        <ErrorState
          message={errorMessage(apiErrorCode(updatesQuery.error) ?? "internal_error")}
          onRetry={() => updatesQuery.refetch()}
        />
      </ServerShell>
    );
  }

  const telemt = updatesQuery.data.targets.find((t) => t.target === "telemt");
  const panel = updatesQuery.data.targets.find((t) => t.target === "panel");

  return (
    <ServerShell title={ru.server.updates.title}>
      {connection.status !== "open" && (
        <StatePill state="warn">{ru.server.updates.sseStale}</StatePill>
      )}

      <div className="flex flex-col gap-4">
        {telemt && (
          <UpdateTarget
            target="telemt"
            data={telemt}
            lockHeld={updatesQuery.data.lock_held}
            hostCaps={hostQuery.data?.caps}
            manualCommands={hostQuery.data?.manual_commands}
            sseEvent={sse.data}
            onApplied={() => queryClient.invalidateQueries({ queryKey: getUpdatesQueryKey() })}
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
            onApplied={() => queryClient.invalidateQueries({ queryKey: getUpdatesQueryKey() })}
          />
        )}
      </div>

      <AutoUpdateForm />

      <div className="flex flex-col gap-4">
        {telemt && <JournalList title={ru.server.updates.targetNames.telemt} entries={telemt.journal ?? []} />}
        {panel && <JournalList title={ru.server.updates.targetNames.panel} entries={panel.journal ?? []} />}
      </div>
    </ServerShell>
  );
}

function JournalList({ title, entries }: { title: string; entries: UpdateRun[] }) {
  const sorted = sortJournalDesc(entries);
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="mb-2 text-sm font-semibold text-text">
        {ru.server.updates.journalTitle} — {title}
      </h2>
      {sorted.length === 0 ? (
        <p className="text-sm text-text-muted">{ru.server.updates.journalEmpty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {sorted.map((entry, i) => (
            <li key={`${entry.run_id}-${entry.phase}-${i}`} className="flex flex-col gap-0.5 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-text">{ru.server.updates.phases[entry.phase]}</span>
                <span className="tabular-nums text-xs text-text-faint">{formatAuditTimestamp(entry.started_at)}</span>
              </div>
              <span className="text-xs text-text-muted">
                {entry.version_from ? `${entry.version_from} → ` : ""}
                {entry.version_to}
                {entry.detail ? ` · ${entry.detail}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
