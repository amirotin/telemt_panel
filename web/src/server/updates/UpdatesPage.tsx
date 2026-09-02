import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { errorMessage, useStrings } from "../../i18n";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { StatePill } from "../../ui/StatePill";
import { Card, CardTitle } from "../../ui/Card";
import { IconRefresh } from "../../ui/icons";
import { apiErrorCode } from "../../people/apiError";
import { useConnectionState, useSnapshot } from "../../realtime";
import type { UpdateTopicEvent } from "../../realtime/topics";
import {
  getHostOptions,
  getUpdatesOptions,
  getUpdatesQueryKey,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { UpdateRun } from "../../lib/api/generated/types.gen";
import { UpdateTarget, type TargetName } from "./UpdateTarget";
import { AutoUpdateForm } from "./AutoUpdateForm";
import {
  isTerminalUpdatePhase,
  updatePhaseStep,
  type UpdatePhase,
} from "./updatePhase.helpers";
import { pickLatestRelease } from "./releases.helpers";
import { formatAuditTimestamp } from "../../journal/timestamp.helpers";

// UpdatesPage keeps the two update targets in one compact version surface.
// The active target expands in place; the auto-update policy and the merged
// journal are separate tasks, not two more copies of the target card.
export function UpdatesPage() {
  const s = useStrings();
  const queryClient = useQueryClient();
  const connection = useConnectionState();
  const sse = useSnapshot<UpdateTopicEvent>("update");
  const hostQuery = useQuery(getHostOptions());

  const updatesQuery = useQuery({
    ...getUpdatesOptions(),
    refetchInterval: (query) => {
      const hasActiveRun = Boolean(query.state.data?.lock_held);
      return hasActiveRun && connection.status !== "open" ? 3000 : false;
    },
  });

  if (updatesQuery.isPending || hostQuery.isPending) {
    return (
      <ServerShell title={s.server.updates.title}>
        <Skeleton className="h-48 w-full" />
      </ServerShell>
    );
  }

  if (updatesQuery.isError) {
    return (
      <ServerShell title={s.server.updates.title}>
        <ErrorState
          message={errorMessage(
            s,
            apiErrorCode(updatesQuery.error) ?? "internal_error",
          )}
          onRetry={() => updatesQuery.refetch()}
        />
      </ServerShell>
    );
  }

  const targets = updatesQuery.data.targets.filter(
    (target): target is typeof target & { target: TargetName } =>
      target.target === "telemt" || target.target === "panel",
  );
  const availableCount = targets.filter((target) =>
    Boolean(pickLatestRelease(target.releases)),
  ).length;
  const activeTarget = targets.find((target) => {
    const event = sse.data?.target === target.target ? sse.data : null;
    const run = event ?? target.active_run;
    return run && !isTerminalUpdatePhase(run.phase as UpdatePhase);
  });

  const headerState = activeTarget
    ? `${s.server.updates.running}: ${s.server.updates.targetNames[activeTarget.target]}`
    : availableCount > 0
      ? s.server.updates.availableCount.replace("{count}", String(availableCount))
      : s.server.updates.allCurrent;

  return (
    <ServerShell title={s.server.updates.title}>
      <div className="grid items-start gap-2.5 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,22rem)]">
        <div className="contents lg:flex lg:flex-col lg:gap-2.5">
        <Card className="order-1 overflow-hidden !p-0">
          <div className="flex min-h-[58px] items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <p className="hidden text-micro uppercase tracking-wide text-text-faint sm:block">
                {s.server.updates.componentsEyebrow}
              </p>
              <CardTitle className="sm:mt-0.5">{s.server.updates.versionsTitle}</CardTitle>
            </div>
            <StatePill
              state={activeTarget ? "muted" : availableCount > 0 ? "warn" : "ok"}
              className={`whitespace-nowrap ${activeTarget ? "bg-accent/15 text-accent [&>span]:bg-accent" : ""}`}
            >
              {headerState}
            </StatePill>
          </div>
          <div>
            {targets.map((target) => (
              <UpdateTarget
                key={target.target}
                target={target.target}
                data={target}
                lockHeld={updatesQuery.data.lock_held}
                hostCaps={hostQuery.data?.caps}
                manualCommands={hostQuery.data?.manual_commands}
                sseEvent={sse.data}
                streamFallback={
                  connection.status !== "open" && updatesQuery.data.lock_held
                }
                onApplied={() =>
                  queryClient.invalidateQueries({
                    queryKey: getUpdatesQueryKey(),
                  })
                }
              />
            ))}
          </div>
        </Card>

        <div className="order-3">
          <UpdateHistory targets={targets} />
        </div>
        </div>

        <div className="contents lg:flex lg:flex-col lg:gap-2.5">
        <div className="order-2">
          <AutoUpdateForm canApply={hostQuery.data?.caps.self_update ?? false} />
        </div>

        <Card className="order-4 !p-0">
          <div className="flex gap-3 border-b border-border px-4 py-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/10 text-micro font-bold text-accent">1</span>
            <p className="text-micro leading-relaxed text-text-muted"><strong className="block text-text">{s.server.updates.oneAtATimeTitle}</strong>{s.server.updates.oneAtATimeDetail}</p>
          </div>
          <div className="flex gap-3 px-4 py-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent"><IconRefresh aria-hidden="true" /></span>
            <p className="text-micro leading-relaxed text-text-muted"><strong className="block text-text">{s.server.updates.rollbackTitle}</strong>{s.server.updates.rollbackDetail}</p>
          </div>
        </Card>
        </div>
      </div>
    </ServerShell>
  );
}

const DOT_CLASSES: Record<string, string> = {
  success: "bg-ok",
  error: "bg-warn",
  rolling_back: "bg-warn",
  running: "bg-accent",
};

interface HistoryEntry {
  target: TargetName;
  run: UpdateRun;
}

function UpdateHistory({
  targets,
}: {
  targets: Array<{
    target: TargetName;
    journal?: UpdateRun[];
  }>;
}) {
  const s = useStrings();
  const [expanded, setExpanded] = useState(false);
  const entries: HistoryEntry[] = targets
    .flatMap((target) =>
      (target.journal ?? []).map((run) => ({ target: target.target, run })),
    )
    .sort(
      (a, b) =>
        new Date(b.run.started_at).getTime() -
        new Date(a.run.started_at).getTime(),
    );
  const visible = expanded ? entries : entries.slice(0, 5);

  return (
    <Card className="overflow-hidden !p-0">
      <div className="flex min-h-[58px] items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-micro uppercase tracking-wide text-text-faint">
            {s.server.updates.historyEyebrow}
          </p>
          <CardTitle className="mt-0.5">{s.server.updates.journalTitle}</CardTitle>
        </div>
        {entries.length > 5 && (
          <button
            type="button"
            className="tap-target -mr-2 px-2 text-micro font-semibold text-accent"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? s.server.updates.collapse : s.server.updates.showAll}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="grid min-h-28 place-items-center px-4 py-5 text-center">
          <div>
            <span className="mx-auto mb-2 grid h-9 w-9 place-items-center rounded-xl bg-surface-2 text-text-faint"><IconRefresh aria-hidden="true" /></span>
            <p className="text-meta font-semibold text-text">{s.server.updates.journalEmpty}</p>
            <p className="mt-1 text-micro text-text-faint">{s.server.updates.journalEmptyDetail}</p>
          </div>
        </div>
      ) : (
        <ul className="px-4">
          {visible.map(({ target, run }, index) => {
            const outcome = updatePhaseStep(run.phase).outcome ?? "running";
            return (
              <li
                key={`${target}-${run.run_id}-${run.phase}-${index}`}
                className="relative grid min-h-[58px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border py-2.5 last:border-b-0"
              >
                <span className="relative flex h-full justify-center">
                  <span className={`relative z-[1] mt-[19px] h-2 w-2 rounded-full ring-4 ring-surface ${DOT_CLASSES[outcome]}`} aria-hidden="true" />
                  <span
                    className={`absolute w-px bg-border ${index === 0 ? "top-1/2" : "top-[-11px]"} ${index === visible.length - 1 ? "bottom-1/2" : "bottom-[-11px]"}`}
                    aria-hidden="true"
                  />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-meta font-semibold text-text">{s.server.updates.phases[run.phase]}</p>
                  <p className="mt-0.5 truncate text-micro text-text-muted">
                    {s.server.updates.targetNames[target]}
                    {run.version_from ? ` · ${run.version_from} → ${run.version_to}` : ` · ${run.version_to}`}
                    {run.detail ? ` · ${run.detail}` : ""}
                  </p>
                </div>
                <time className="max-w-28 text-right text-micro tabular-nums text-text-faint">
                  {formatAuditTimestamp(run.started_at, s)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
