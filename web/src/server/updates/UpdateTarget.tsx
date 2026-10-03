import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useStrings } from "../../i18n";
import { Button } from "../../ui/Button";
import { CopyField } from "../../ui/CopyField";
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
import { pickLatestRelease,type ReleaseItem } from "./releases.helpers";
import {ReleasePicker,ReleaseConfirmation} from './ReleasePicker';
import { isTerminalUpdatePhase, type UpdatePhase } from "./updatePhase.helpers";
import { UpdateStepper } from "./UpdateStepper";
import { usePanelRestartWatch } from "./usePanelRestartWatch";
import { selectUpdateRun } from "./updateRun.helpers";

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
  refreshing?:boolean;
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
  refreshing=false,
}: UpdateTargetProps) {
  const s = useStrings();
  const t=s.releasePicker;
  const [pickerOpen,setPickerOpen]=useState(false);
  const [picked,setPicked]=useState<{version:string;from:string;newer:boolean}|null>(null);
  const [confirming,setConfirming]=useState<{release:ReleaseItem;from:string}|null>(null);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [panelRunID, setPanelRunID] = useState<string | null>(null);

  const applyMutation = useMutation({
    ...applyUpdateMutation(),
    onSuccess: () => {
      setConfirming(null);
      setPicked(null);
      onApplied();
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const latest = pickLatestRelease(data.releases);
  const activeRun = selectUpdateRun(data, sseEvent);
  const phase = activeRun?.phase as UpdatePhase | undefined;
  const runIsActive = Boolean(phase && !isTerminalUpdatePhase(phase));
  const canApply = hostCaps?.self_update ?? false;
  const catalogError=!!data.releases_error;
  const blocked=lockHeld||runIsActive||applyMutation.isPending||refreshing;
  const selected=picked&&picked.from===data.current_version?data.releases.find(r=>r.version===picked.version&&Boolean(r.newer)===picked.newer):undefined;
  const validSelection=!!selected&&!catalogError;
  const confirmationChanged=!validSelection||confirming?.from!==data.current_version||confirming?.release.version!==selected?.version||Boolean(confirming?.release.prerelease)!==Boolean(selected?.prerelease);

  if (target === "panel" && runIsActive && panelRunID !== activeRun?.run_id) {
    setPanelRunID(activeRun?.run_id ?? null);
  }
  const restarting = target === "panel" && (phase === "restarting" || (phase === "done" && panelRunID === activeRun?.run_id));
  const restartWatch = usePanelRestartWatch(
    restarting,
    activeRun?.run_id ?? "",
    activeRun?.version_to ?? "",
  );
  useEffect(() => {
    if (restartWatch.status === "reload") window.location.reload();
  }, [restartWatch.status]);

  const TargetIcon = target === "telemt" ? IconTelegram : IconServer;

  return (
    <article className="uv-target" data-update-target={target}>
      <div className="uv-row">
        <span className={`grid h-10 w-10 place-items-center rounded-xl ${target === "telemt" ? "bg-ok/10 text-ok" : "bg-accent/10 text-accent"}`} aria-hidden="true">
          <TargetIcon />
        </span>

        <div className="uv-name">
          <h3>
            {s.server.updates.targetNames[target]}
          </h3>
          <p>
            {target === "telemt"
              ? s.server.updates.telemtDescription
              : s.server.updates.panelDescription}
          </p>
        </div>

        <div className="uv-installed"><span>{t.installed}</span><strong>{data.current_version||'—'}</strong></div>
        <div className="uv-state">
          {catalogError&&!runIsActive?<StatePill state="warn">{t.partialCatalog}</StatePill>:<TargetState phase={phase} hasUpdate={Boolean(latest)} />}
          {latest&&!catalogError&&<small>{t.latest} {latest.version}</small>}
        </div>
        {catalogError?<Button variant="secondary" className="uv-choose" disabled={refreshing||runIsActive} onClick={onApplied}>{s.common.retry}</Button>:<Button variant="secondary" className="uv-choose" disabled={blocked||data.releases.length===0} onClick={()=>setPickerOpen(true)}>{t.choose}<span aria-hidden="true">⌄</span></Button>}
      </div>
      {catalogError&&<p className="uv-row-note text-warn" role="alert">{t.catalogError}</p>}
      {!catalogError&&!data.releases.length&&<p className="uv-row-note">{t.empty}</p>}
      {picked&&<div className={`uv-selection ${picked.newer?'':'older'}`}>
        <div><small>{picked.newer?t.update:t.downgrade}</small><p><strong>{picked.from||'—'}</strong><span className="uv-arrow" aria-hidden="true">→</span><strong>{picked.version}</strong>{selected?.prerelease&&<span className="uv-prerelease">{t.pre}</span>}</p></div>
        <div className="uv-selected-actions">
          <Button variant="secondary" size="sm" disabled={applyMutation.isPending} onClick={()=>setPicked(null)}>{t.reset}</Button>
          {canApply?<Button className={picked.newer?'':'uv-downgrade-button'} disabled={blocked||!validSelection||!data.current_version} onClick={()=>{if(selected){applyMutation.reset();setConfirming({release:selected,from:data.current_version});}}}>{t.continue}<span aria-hidden="true"> →</span></Button>:<span className="text-meta text-text-muted">{t.manualShort}</span>}
        </div>
      </div>}
      {picked&&!validSelection&&<p className="uv-row-note text-warn" role="alert">{t.changed}</p>}
      {!data.current_version&&<p className="uv-row-note text-warn">{t.unknownCurrent}</p>}
      {!canApply&&<div className="uv-row-note"><p>{t.manual}</p><Button variant="secondary" size="sm" className="mt-2" onClick={()=>setCapabilityOpen(true)}>{s.server.updates.howToUpdate}</Button></div>}
      {pickerOpen&&<ReleasePicker target={target} current={data.current_version} releases={data.releases} selected={picked?.version??null} blocked={blocked} error={catalogError} onChoose={release=>{setPicked({version:release.version,from:data.current_version,newer:!!release.newer});setPickerOpen(false);}} onClose={()=>setPickerOpen(false)}/>}
      {confirming&&<ReleaseConfirmation target={target} current={confirming.from} release={confirming.release} blocked={blocked||!canApply} changed={confirmationChanged} pending={applyMutation.isPending} error={applyMutation.error?apiErrorMessage(applyMutation.error,s):null} onClose={()=>setConfirming(null)} onConfirm={()=>{if(selected&&!confirmationChanged&&!blocked&&canApply&&data.current_version)applyMutation.mutate({path:{target},body:{version:selected.version}});}}/>}

      {activeRun && (
        <div className="border-t border-border bg-surface-sunken px-4 py-3 sm:pl-[4.5rem]">
          <UpdateStepper
            phase={(restartWatch.failure ?? activeRun).phase as UpdatePhase}
            detail={(restartWatch.failure ?? activeRun).detail}
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
  return <StatePill state="muted">{s.releasePicker.noNewer}</StatePill>;
}
