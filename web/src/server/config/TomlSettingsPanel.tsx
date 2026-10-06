import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage, useStrings } from "../../i18n";
import { apiErrorMessage } from "../../people/apiError";
import { DraftSessionActions } from "../../lib/draftSessionActions";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { ErrorState } from "../../ui/ErrorState";
import { SectionLabel } from "../../ui/SectionLabel";
import { Sheet } from "../../ui/Sheet";
import { Skeleton } from "../../ui/Skeleton";
import { Notice } from "../Notice";
import { useIsDesktop } from "../useIsDesktop";
import { getTelemtConfigTomlQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { TelemtConfigPatchResult, TelemtConfigTomlPreview } from "../../lib/api/generated/types.gen";
import { PatchResultNotice } from "./PatchResultNotice";
import { ReloadPolicyPicker } from "./ReloadPolicyPicker";
import { TomlConfigEditor } from "./TomlConfigEditor";
import { useTomlSettingsSession, type TomlSettingsController } from "./useTomlSettingsSession";

export function TomlSettingsPanel({ canRestartTelemt, onApplied }: {
  canRestartTelemt: boolean;
  onApplied?: (result: TelemtConfigPatchResult) => void | Promise<void>;
}) {
  const controller = useTomlSettingsSession({ enabled: true, onApplied });
  return <TomlSettingsView controller={controller} canRestartTelemt={canRestartTelemt} />;
}

export function TomlSettingsView({ controller, canRestartTelemt }: {
  controller: TomlSettingsController;
  canRestartTelemt: boolean;
}) {
  const s = useStrings();
  const queryClient = useQueryClient();
  const isDesktop = useIsDesktop();
  const [mobileOpen, setMobileOpen] = useState(false);
  const {
    query, session, draft, dirty, previewCurrent, changed, result,
    reloadPolicy, setReloadPolicy, conflict, unknownOutcome,
    previewMutation, patchMutation, reloadMutation, restartMutation,
    updateDraft, validate, save, discard, copyDraft,
  } = controller;
  if (query.isLoading) return <Skeleton className="h-[520px] w-full" />;
  if (!query.data) return <ErrorState message={query.error ? apiErrorMessage(query.error, s) : s.common.error} onRetry={() => query.refetch()} />;
  const initial = query.data;

  const editor = (
    <TomlConfigEditor
      initialText={draft}
      onChange={updateDraft}
      labelledBy="telemt-toml-editor-title"
    />
  );

  return (
    <div className="flex flex-col gap-3" data-testid="toml-settings-panel">
      {unknownOutcome && <Notice tone="warn" title={errorMessage(s, "telemt_config_outcome_unknown")}>
        <Button variant="secondary" onClick={() => void queryClient.refetchQueries({ queryKey: getTelemtConfigTomlQueryKey() })}>{s.server.config.checkWrite}</Button>
      </Notice>}
      <Notice tone="info" title={s.server.config.toml.projectionTitle}>
        <p className="text-meta leading-relaxed text-text-muted">{s.server.config.toml.projectionNote}</p>
        <p className="text-micro text-text-faint">{s.server.config.toml.projectionDetail}</p>
      </Notice>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionLabel>{s.server.config.toml.kicker}</SectionLabel>
          <h2 id="telemt-toml-editor-title" className="mt-1 text-[17px] font-bold text-text">{s.server.config.toml.title}</h2>
          <p className="mt-1 text-meta text-text-muted">{initial.source_sections.join(" · ")} · revision {session.baseline.revision?.slice(0, 8)}</p>
        </div>
        {!isDesktop && <Button variant="secondary" onClick={() => setMobileOpen(true)}>{s.server.config.toml.openEditor}</Button>}
      </div>

      {(dirty || session.remote || conflict) && <DraftSessionActions conflict={!!session.remote || conflict} onDiscard={discard} onCopy={() => void copyDraft()} disabled={patchMutation.isPending || (conflict && !session.remote)} />}

      {isDesktop ? editor : (
        <Card className="overflow-hidden p-0">
          <pre className="max-h-44 overflow-hidden whitespace-pre-wrap p-4 font-mono text-[12px] leading-relaxed text-text-muted" aria-hidden="true">{draft.split("\n").slice(0, 12).join("\n")}</pre>
          <button type="button" className="min-h-11 w-full border-t border-border px-4 text-left text-meta font-semibold text-accent" onClick={() => setMobileOpen(true)}>{s.server.config.toml.openEditor}</button>
        </Card>
      )}

      <Sheet
        open={!isDesktop && mobileOpen}
        onClose={() => setMobileOpen(false)}
        placement="form"
        eyebrow={s.server.config.toml.kicker}
        title={s.server.config.toml.title}
        subtitle={s.server.config.toml.mobileNote}
        bodyClassName="flex min-h-0 flex-col gap-3 !overflow-hidden !p-3"
      >
        {(session.remote || conflict) && <DraftSessionActions conflict onDiscard={discard} onCopy={() => void copyDraft()} disabled={patchMutation.isPending || (conflict && !session.remote)} />}
        <div className="min-h-0 flex-1 overflow-hidden">{editor}</div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border pt-3 pb-safe">
          <Button variant="secondary" onClick={() => setMobileOpen(false)}>{s.common.cancel}</Button>
          <Button onClick={() => { setMobileOpen(false); validate(); }} disabled={!dirty || previewMutation.isPending}>{s.server.config.toml.doneAndValidate}</Button>
        </div>
      </Sheet>

      {previewCurrent && <TOMLPreview preview={previewCurrent} />}

      {result && !dirty && !session.remote && (
        <PatchResultNotice
          result={result}
          canRestartTelemt={canRestartTelemt}
          onReloadNow={() => reloadMutation.mutate({ body: { mode: "instant" } })}
          onRestartNow={() => restartMutation.mutate({})}
          reloadPending={reloadMutation.isPending}
          restartPending={restartMutation.isPending}
        />
      )}

      <Card className="relative z-10 flex flex-col gap-3 border border-border/80 bg-surface/95 shadow-xl backdrop-blur lg:sticky lg:bottom-2 lg:flex-row lg:items-end lg:justify-between">
        <ReloadPolicyPicker value={reloadPolicy} onChange={setReloadPolicy} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-micro text-text-faint lg:mr-1">
            {!dirty ? s.server.config.noChanges : previewCurrent ? s.server.config.toml.validatedCount.replace("{count}", String(changed)) : s.server.config.toml.needsValidation}
          </span>
          <Button variant="secondary" onClick={validate} disabled={!dirty || previewMutation.isPending || patchMutation.isPending}>
            {previewMutation.isPending ? s.server.config.toml.validating : s.server.config.toml.validate}
          </Button>
          <Button onClick={save} disabled={!previewCurrent || changed === 0 || patchMutation.isPending}>
            {patchMutation.isPending ? s.server.config.saving : s.server.config.toml.saveValidated}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function TOMLPreview({ preview }: { preview: TelemtConfigTomlPreview }) {
  const s = useStrings();
  return (
    <Card className="flex flex-col gap-3 border border-border/70">
      <div className="flex items-center justify-between gap-3">
        <div><SectionLabel>{s.server.config.toml.previewKicker}</SectionLabel><h3 className="mt-1 text-[14px] font-semibold text-text">{s.server.config.toml.previewTitle}</h3></div>
        <span className="rounded-full bg-accent/10 px-2.5 py-1 text-micro font-bold text-accent">{preview.changed_paths.length}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {preview.changed_paths.map((path) => <code key={path} className="truncate border-b border-border py-2 font-mono text-micro text-text-muted">{path}</code>)}
      </div>
      {preview.materialized_sections.length > 0 && <Notice tone="warn" title={s.server.config.toml.materializedTitle}><p className="font-mono text-meta text-text">{preview.materialized_sections.join(", ")}</p><p className="text-micro text-text-muted">{s.server.config.toml.materializedDetail}</p></Notice>}
      {preview.array_replacements.length > 0 && <Notice tone="warn" title={s.server.config.toml.arraysTitle}><p className="font-mono text-meta text-text">{preview.array_replacements.join(", ")}</p><p className="text-micro text-text-muted">{s.server.config.toml.arraysDetail}</p></Notice>}
      <details>
        <summary className="cursor-pointer text-meta font-semibold text-text-muted">{s.server.config.toml.patchTitle}</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed text-text">{formatExactJSON(preview.patch_json)}</pre>
      </details>
    </Card>
  );
}

function formatExactJSON(value: string): string {
  // Formatting through JSON.parse would round unsafe integer literals.
  // The backend already emits compact valid JSON, so only add safe visual
  // line breaks around structural punctuation and leave numeric tokens intact.
  return value.replaceAll("{", "{\n  ").replaceAll(",", ",\n  ").replaceAll("}", "\n}");
}
