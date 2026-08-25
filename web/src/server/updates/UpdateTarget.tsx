import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ru } from "../../i18n/ru";
import { KVRow } from "../../ui/KVRow";
import { Button } from "../../ui/Button";
import { CopyField } from "../../ui/CopyField";
import { ConfirmView } from "../../ui/ConfirmView";
import { pushToast } from "../../ui/Toast";
import { apiErrorMessage } from "../../people/apiError";
import { applyUpdateMutation } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { HostInfo, UpdatesStatus } from "../../lib/api/generated/types.gen";
import type { UpdateTopicEvent } from "../../realtime/topics";
import { pickLatestRelease } from "./releases.helpers";
import { isTerminalUpdatePhase, type UpdatePhase } from "./updatePhase.helpers";
import { UpdateStepper } from "./UpdateStepper";
import { usePanelRestartWatch } from "./usePanelRestartWatch";

export type TargetName = "telemt" | "panel";
type TargetStatus = UpdatesStatus["targets"][number];

export interface UpdateTargetProps {
  target: TargetName;
  data: TargetStatus;
  lockHeld: boolean;
  hostCaps: HostInfo["caps"] | undefined;
  manualCommands: Record<string, string> | undefined;
  /** The shared "update" SSE topic's latest event, already filtered by the caller — or null if it belongs to the other target. */
  sseEvent: UpdateTopicEvent | null;
  onApplied: () => void;
}

// UpdateTarget — the one component both Telemt and the panel render
// through (06-ui.md §Обновления: "один компонент <UpdateTarget>, никаких
// дублей UI на цель"): current/latest version, live phase stepper (SSE
// `update` topic, filtered to this target, with the REST snapshot's own
// `active_run` as a fallback whenever no live event has arrived yet), and
// the "Обновить" confirm-and-apply flow.
export function UpdateTarget({
  target,
  data,
  lockHeld,
  hostCaps,
  manualCommands,
  sseEvent,
  onApplied,
}: UpdateTargetProps) {
  const [confirming, setConfirming] = useState(false);

  const applyMutation = useMutation({
    ...applyUpdateMutation(),
    onSuccess: () => {
      setConfirming(false);
      onApplied();
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  const latest = pickLatestRelease(data.releases);
  const liveRun = sseEvent && sseEvent.target === target ? sseEvent : null;
  const activeRun = liveRun ?? data.active_run ?? null;
  const runIsActive = activeRun !== null && !isTerminalUpdatePhase(activeRun.phase as UpdatePhase);

  const canSelfUpdate = hostCaps?.self_update ?? false;
  const otherRunBlocking = lockHeld && !runIsActive;

  const restarting = target === "panel" && activeRun?.phase === "restarting";
  const restartWatch = usePanelRestartWatch(restarting, activeRun?.version_to ?? "");
  useEffect(() => {
    if (restartWatch.status === "reload") window.location.reload();
  }, [restartWatch.status]);

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="mb-2 text-sm font-semibold text-text">{ru.server.updates.targetNames[target]}</h2>

      <div className="flex flex-col">
        <KVRow label={ru.server.updates.currentVersion} value={data.current_version} monospace />
        <KVRow
          label={ru.server.updates.latestVersion}
          value={latest ? latest.version : ru.server.updates.upToDate}
          monospace
        />
      </div>

      {restarting && restartWatch.status === "wait" && (
        <p className="mt-3 text-sm text-warn">{ru.server.updates.panelRestarting}</p>
      )}

      {restarting && restartWatch.status === "timeout" && (
        <div className="mt-3 flex flex-col gap-2 rounded-lg border border-error/30 bg-error/5 p-3">
          <p className="text-sm font-medium text-error">{ru.server.updates.panelRestartTimeoutTitle}</p>
          <p className="text-xs text-text-muted">{ru.server.updates.panelRestartTimeoutDescription}</p>
          {manualCommands?.["restart_panel"] && <CopyField value={manualCommands["restart_panel"]} />}
          <Button variant="secondary" onClick={restartWatch.retry} className="self-start">
            {ru.server.updates.panelRestartRetry}
          </Button>
        </div>
      )}

      {activeRun ? (
        <div className="mt-3">
          <UpdateStepper phase={activeRun.phase as UpdatePhase} detail={activeRun.detail} />
        </div>
      ) : (
        <p className="mt-3 text-sm text-text-muted">{ru.server.updates.noActiveRun}</p>
      )}

      {!runIsActive &&
        latest &&
        (confirming ? (
          <div className="mt-3">
            <ConfirmView
              description={`${ru.server.updates.confirmPrefix} ${latest.version}?`}
              confirmLabel={ru.server.updates.update}
              pending={applyMutation.isPending}
              onCancel={() => setConfirming(false)}
              onConfirm={() => applyMutation.mutate({ path: { target }, body: { version: latest.version } })}
            />
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-1">
            <Button onClick={() => setConfirming(true)} disabled={!canSelfUpdate || otherRunBlocking} className="self-start">
              {ru.server.updates.update}
            </Button>
            {!canSelfUpdate && manualCommands?.["self_update"] && (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-text-faint">{ru.server.updates.manualOnly}</p>
                <CopyField value={manualCommands["self_update"]} />
              </div>
            )}
            {canSelfUpdate && otherRunBlocking && (
              <p className="text-xs text-text-faint">{ru.server.updates.lockHeld}</p>
            )}
          </div>
        ))}
    </section>
  );
}
