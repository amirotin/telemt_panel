import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ru } from "../../i18n/ru";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { CopyField } from "../../ui/CopyField";
import { ConfirmView } from "../../ui/ConfirmView";
import { SectionLabel } from "../../ui/SectionLabel";
import { IconUpgrade } from "../../ui/icons";
import { pushToast } from "../../ui/Toast";
import { apiErrorMessage } from "../../people/apiError";
import { applyUpdateMutation } from "../../lib/api/generated/@tanstack/react-query.gen";
import type {
  HostInfo,
  UpdatesStatus,
} from "../../lib/api/generated/types.gen";
import type { UpdateTopicEvent } from "../../realtime/topics";
import { Notice } from "../Notice";
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
//
// Layout follows the prototype's Обновления artboard: the two versions as
// a pair of small figure cards, then the "доступна версия X" offer as an
// accent-tiled row with a full-width action under it.
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
  const runIsActive =
    activeRun !== null &&
    !isTerminalUpdatePhase(activeRun.phase as UpdatePhase);

  const canSelfUpdate = hostCaps?.self_update ?? false;
  const otherRunBlocking = lockHeld && !runIsActive;

  const restarting = target === "panel" && activeRun?.phase === "restarting";
  const restartWatch = usePanelRestartWatch(
    restarting,
    activeRun?.version_to ?? "",
  );
  useEffect(() => {
    if (restartWatch.status === "reload") window.location.reload();
  }, [restartWatch.status]);

  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>{ru.server.updates.targetNames[target]}</CardTitle>

      <div className="grid grid-cols-2 gap-2.5">
        <VersionCard
          label={ru.server.updates.currentVersion}
          value={data.current_version}
        />
        <VersionCard
          label={ru.server.updates.latestVersion}
          value={latest ? latest.version : ru.server.updates.upToDate}
          muted={!latest}
        />
      </div>

      {restarting && restartWatch.status === "wait" && (
        <p className="text-meta text-warn">
          {ru.server.updates.panelRestarting}
        </p>
      )}

      {restarting && restartWatch.status === "timeout" && (
        <Notice tone="error" title={ru.server.updates.panelRestartTimeoutTitle}>
          <p className="text-meta leading-relaxed text-text-muted">
            {ru.server.updates.panelRestartTimeoutDescription}
          </p>
          {manualCommands?.["restart_panel"] && (
            <CopyField value={manualCommands["restart_panel"]} />
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={restartWatch.retry}
            className="self-start"
          >
            {ru.server.updates.panelRestartRetry}
          </Button>
        </Notice>
      )}

      {activeRun ? (
        <div className="rounded-md bg-surface-sunken p-3">
          <UpdateStepper
            phase={activeRun.phase as UpdatePhase}
            detail={activeRun.detail}
          />
        </div>
      ) : (
        <p className="text-meta text-text-faint">
          {ru.server.updates.noActiveRun}
        </p>
      )}

      {!runIsActive &&
        latest &&
        (confirming ? (
          <ConfirmView
            description={`${ru.server.updates.confirmPrefix} ${latest.version}?`}
            confirmLabel={ru.server.updates.update}
            pending={applyMutation.isPending}
            onCancel={() => setConfirming(false)}
            onConfirm={() =>
              applyMutation.mutate({
                path: { target },
                body: { version: latest.version },
              })
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-accent/15 text-[16px] text-accent"
              >
                <IconUpgrade />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-row font-bold text-text">
                  {ru.server.updates.availablePrefix} {latest.version}
                </p>
                <p className="truncate font-mono text-micro text-text-muted">
                  {ru.server.updates.targetNames[target]} ·{" "}
                  {data.current_version} → {latest.version}
                </p>
              </div>
            </div>
            <Button
              onClick={() => setConfirming(true)}
              disabled={!canSelfUpdate || otherRunBlocking}
              className="w-full"
            >
              {ru.server.updates.update}
            </Button>
            {!canSelfUpdate && manualCommands?.["self_update"] && (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>{ru.server.updates.manualOnly}</SectionLabel>
                <CopyField value={manualCommands["self_update"]} />
              </div>
            )}
            {canSelfUpdate && otherRunBlocking && (
              <p className="text-micro text-text-faint">
                {ru.server.updates.lockHeld}
              </p>
            )}
          </div>
        ))}
    </Card>
  );
}

// VersionCard — the prototype's small figure card: a muted caption over a
// monospace version number.
function VersionCard({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-md bg-surface-sunken px-3.5 py-2.5">
      <p className="text-micro text-text-muted">{label}</p>
      <p
        className={`mt-0.5 truncate font-mono tabular-nums ${
          muted
            ? "text-meta text-text-muted"
            : "text-[18px] font-bold text-text"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
