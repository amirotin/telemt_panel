import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useStrings } from "../../i18n";
import { Button } from "../../ui/Button";
import { CopyField } from "../../ui/CopyField";
import { ConfirmView } from "../../ui/ConfirmView";
import { Sheet } from "../../ui/Sheet";
import { StatePill } from "../../ui/StatePill";
import { IconServer, IconTelegram } from "../../ui/icons";
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
  sseEvent: UpdateTopicEvent | null;
  streamFallback: boolean;
  onApplied: () => void;
}

// One target is a row in the shared version surface. Progress and failures
// expand under that row, so the admin never has to correlate a status card
// with a separate progress card elsewhere on the page.
export function UpdateTarget({
  target,
  data,
  lockHeld,
  hostCaps,
  manualCommands,
  sseEvent,
  streamFallback,
  onApplied,
}: UpdateTargetProps) {
  const s = useStrings();
  const [confirming, setConfirming] = useState(false);
  const [capabilityOpen, setCapabilityOpen] = useState(false);

  const applyMutation = useMutation({
    ...applyUpdateMutation(),
    onSuccess: () => {
      setConfirming(false);
      onApplied();
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const latest = pickLatestRelease(data.releases);
  const liveRun = sseEvent && sseEvent.target === target ? sseEvent : null;
  const activeRun = liveRun ?? data.active_run ?? null;
  const phase = activeRun?.phase as UpdatePhase | undefined;
  const runIsActive = Boolean(phase && !isTerminalUpdatePhase(phase));
  const canApply = hostCaps?.self_update ?? false;
  const otherRunBlocking = lockHeld && !runIsActive;

  const restarting = target === "panel" && phase === "restarting";
  const restartWatch = usePanelRestartWatch(
    restarting,
    activeRun?.version_to ?? "",
  );
  useEffect(() => {
    if (restartWatch.status === "reload") window.location.reload();
  }, [restartWatch.status]);

  const shownLatest = latest?.version ?? data.current_version;
  const TargetIcon = target === "telemt" ? IconTelegram : IconServer;

  return (
    <article className="border-b border-border last:border-b-0">
      <div className="grid min-h-[92px] grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:min-h-[72px] sm:grid-cols-[40px_minmax(6rem,.55fr)_minmax(13rem,1fr)_auto_auto] sm:gap-x-4">
        <span className={`grid h-10 w-10 place-items-center rounded-xl ${target === "telemt" ? "bg-ok/10 text-ok" : "bg-accent/10 text-accent"}`} aria-hidden="true">
          <TargetIcon />
        </span>

        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-text">
            {s.server.updates.targetNames[target]}
          </p>
          <p className="mt-0.5 hidden text-micro text-text-faint sm:block">
            {target === "telemt"
              ? s.server.updates.telemtDescription
              : s.server.updates.panelDescription}
          </p>
        </div>

        <div className="col-span-2 col-start-2 row-start-2 grid min-w-0 grid-cols-[minmax(0,auto)_28px_minmax(0,1fr)] items-center gap-2 sm:col-auto sm:row-auto sm:grid-cols-[minmax(0,auto)_38px_minmax(0,1fr)]">
          <Version label={s.server.updates.installedVersion} value={data.current_version} />
          <span className={`relative h-px bg-border-strong ${latest ? "after:absolute after:right-0 after:top-[-2px] after:h-[5px] after:w-[5px] after:rotate-45 after:border-r after:border-t after:border-text-faint" : "opacity-40"}`} aria-hidden="true" />
          <Version
            label={latest ? s.server.updates.availableVersion : s.server.updates.latestInstalledVersion}
            value={shownLatest}
          />
        </div>

        <div className="col-start-3 row-start-1 justify-self-end sm:col-auto sm:row-auto">
          <TargetState phase={phase} hasUpdate={Boolean(latest)} />
        </div>

        {latest && !runIsActive && (
          <div className="col-span-3 row-start-3 sm:col-auto sm:row-auto">
            {canApply ? (
              <Button
                variant={otherRunBlocking ? "secondary" : "primary"}
                size="sm"
                disabled={otherRunBlocking || applyMutation.isPending}
                onClick={() => setConfirming(true)}
                className="w-full whitespace-nowrap sm:w-auto"
              >
                {otherRunBlocking
                  ? s.server.updates.waiting
                  : s.server.updates.update}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCapabilityOpen(true)}
                className="w-full whitespace-nowrap sm:w-auto"
              >
                {s.server.updates.howToUpdate}
              </Button>
            )}
          </div>
        )}
      </div>

      {confirming && latest && (
        <div className="border-t border-border bg-surface-sunken px-4 py-3 sm:pl-[4.5rem]">
          <ConfirmView
            description={`${s.server.updates.confirmPrefix} ${latest.version}?`}
            confirmLabel={s.server.updates.update}
            pending={applyMutation.isPending}
            onCancel={() => setConfirming(false)}
            onConfirm={() =>
              applyMutation.mutate({
                path: { target },
                body: { version: latest.version },
              })
            }
          />
        </div>
      )}

      {activeRun && (
        <div className="border-t border-border bg-surface-sunken px-4 py-3 sm:pl-[4.5rem]">
          <UpdateStepper
            phase={activeRun.phase as UpdatePhase}
            detail={activeRun.detail}
            streamFallback={streamFallback && runIsActive}
          />
        </div>
      )}

      {restarting && restartWatch.status === "wait" && (
        <p className="border-t border-border px-4 py-2 text-meta text-warn sm:pl-[4.5rem]">
          {s.server.updates.panelRestarting}
        </p>
      )}

      {restarting && restartWatch.status === "timeout" && (
        <div className="border-t border-border px-4 py-3 sm:pl-[4.5rem]">
          <Notice tone="error" title={s.server.updates.panelRestartTimeoutTitle}>
            <p className="text-meta leading-relaxed text-text-muted">
              {s.server.updates.panelRestartTimeoutDescription}
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
              {s.server.updates.panelRestartRetry}
            </Button>
          </Notice>
        </div>
      )}

      <Sheet
        open={capabilityOpen}
        onClose={() => setCapabilityOpen(false)}
        eyebrow={s.server.updates.hostCapabilities}
        title={s.server.updates.installUnavailableTitle}
        placement="auto"
      >
        <div className="flex flex-col gap-3">
          <p className="text-meta leading-relaxed text-text-muted">
            {s.server.updates.installUnavailableDetail}
          </p>
          <div className="rounded-xl border border-warn/25 bg-warn/[0.06] p-3">
            <p className="text-meta font-semibold text-warn">
              {s.server.updates.installerPendingTitle}
            </p>
            <p className="mt-1 text-micro leading-relaxed text-text-muted">
              {s.server.updates.installerPendingDetail}
            </p>
          </div>
          <Button className="self-start" onClick={() => setCapabilityOpen(false)}>
            {s.server.updates.dismiss}
          </Button>
        </div>
      </Sheet>
    </article>
  );
}

function Version({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-[9px] uppercase tracking-wide text-text-faint">
        {label}
      </span>
      <strong className="mt-0.5 block truncate font-mono text-[14px] tabular-nums text-text">
        {value}
      </strong>
    </span>
  );
}

function TargetState({
  phase,
  hasUpdate,
}: {
  phase: UpdatePhase | undefined;
  hasUpdate: boolean;
}) {
  const s = useStrings();
  if (phase === "failed") {
    return <StatePill state="error">{s.server.updates.phases.failed}</StatePill>;
  }
  if (phase === "rolling_back" || phase === "rolled_back") {
    return <StatePill state="warn">{s.server.updates.phases[phase]}</StatePill>;
  }
  if (phase && !isTerminalUpdatePhase(phase)) {
    return (
      <StatePill state="muted" className="bg-accent/15 text-accent [&>span]:bg-accent">
        {s.server.updates.phases[phase]}
      </StatePill>
    );
  }
  if (hasUpdate) {
    return (
      <StatePill state="muted" className="bg-accent/15 text-accent [&>span]:bg-accent">
        {s.server.updates.available}
      </StatePill>
    );
  }
  return <StatePill state="ok">{s.server.updates.current}</StatePill>;
}
