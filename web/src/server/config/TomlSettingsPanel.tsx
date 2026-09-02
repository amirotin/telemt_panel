import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStrings } from "../../i18n";
import { apiErrorMessage } from "../../people/apiError";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { ErrorState } from "../../ui/ErrorState";
import { SectionLabel } from "../../ui/SectionLabel";
import { Sheet } from "../../ui/Sheet";
import { Skeleton } from "../../ui/Skeleton";
import { pushToast } from "../../ui/Toast";
import { Notice } from "../Notice";
import { useIsDesktop } from "../useIsDesktop";
import {
  getTelemtConfigQueryKey,
  getTelemtConfigTomlOptions,
  getTelemtConfigTomlQueryKey,
  patchTelemtConfigTomlMutation,
  previewTelemtConfigTomlMutation,
  reloadTelemtMutation,
  restartTelemtServiceMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type {
  TelemtConfigPatchResult,
  TelemtConfigToml,
  TelemtConfigTomlPreview,
} from "../../lib/api/generated/types.gen";
import { PatchResultNotice } from "./PatchResultNotice";
import { recordPendingChanges } from "./pendingChanges";
import { ReloadPolicyPicker } from "./ReloadPolicyPicker";
import {
  DEFAULT_RELOAD_POLICY,
  toPatchReloadQuery,
  type ReloadPolicyState,
} from "./reloadPolicy";
import { TomlConfigEditor } from "./TomlConfigEditor";

export function TomlSettingsPanel({
  canRestartTelemt,
  onApplied,
}: {
  canRestartTelemt: boolean;
  onApplied?: (result: TelemtConfigPatchResult) => void | Promise<void>;
}) {
  const s = useStrings();
  const query = useQuery(getTelemtConfigTomlOptions());

  if (query.isLoading) return <Skeleton className="h-[520px] w-full" />;
  if (query.isError || !query.data) {
    return <ErrorState message={query.error ? apiErrorMessage(query.error, s) : s.common.error} onRetry={() => query.refetch()} />;
  }
  return <TomlSettingsSession key={query.data.revision} initial={query.data} canRestartTelemt={canRestartTelemt} onApplied={onApplied} />;
}

function TomlSettingsSession({
  initial,
  canRestartTelemt,
  onApplied,
}: {
  initial: TelemtConfigToml;
  canRestartTelemt: boolean;
  onApplied?: (result: TelemtConfigPatchResult) => void | Promise<void>;
}) {
  const s = useStrings();
  const queryClient = useQueryClient();
  const isDesktop = useIsDesktop();
  const [draft, setDraft] = useState(initial.toml_projection);
  const [validatedDraft, setValidatedDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<TelemtConfigTomlPreview | null>(null);
  const [result, setResult] = useState<TelemtConfigPatchResult | null>(null);
  const [reloadPolicy, setReloadPolicy] = useState<ReloadPolicyState>(DEFAULT_RELOAD_POLICY);
  const [mobileOpen, setMobileOpen] = useState(false);

  const dirty = draft !== initial.toml_projection;
  const previewCurrent = validatedDraft === draft ? preview : null;
  const changed = previewCurrent?.changed_paths.length ?? 0;

  const previewMutation = useMutation({
    ...previewTelemtConfigTomlMutation(),
    onSuccess: (next) => {
      setPreview(next);
      setValidatedDraft(draft);
      setResult(null);
    },
    onError: (error) => {
      setPreview(null);
      setValidatedDraft(null);
      pushToast(apiErrorMessage(error, s), "error");
    },
  });

  const patchMutation = useMutation({
    ...patchTelemtConfigTomlMutation(),
    onSuccess: async (next) => {
      recordPendingChanges(next);
      setResult(next);
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: getTelemtConfigTomlQueryKey() });
      queryClient.invalidateQueries({ queryKey: getTelemtConfigQueryKey() });
      await onApplied?.(next);
    },
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });

  const reloadMutation = useMutation({
    ...reloadTelemtMutation(),
    onSuccess: () => pushToast(s.server.config.toml.reloadAccepted, "ok"),
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });
  const restartMutation = useMutation({
    ...restartTelemtServiceMutation(),
    onSuccess: () => pushToast(s.server.config.toml.restartAccepted, "ok"),
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });

  function updateDraft(next: string) {
    setDraft(next);
    setValidatedDraft(null);
    setPreview(null);
    setResult(null);
  }

  function validate() {
    previewMutation.mutate({
      headers: { "If-Match": initial.revision },
      body: { toml_projection: draft },
    });
  }

  function save() {
    if (!previewCurrent || changed === 0) return;
    patchMutation.mutate({
      headers: { "If-Match": initial.revision },
      query: toPatchReloadQuery(reloadPolicy),
      body: { toml_projection: draft },
    });
  }

  const editor = (
    <TomlConfigEditor
      key={`${initial.revision}:${mobileOpen ? "mobile" : "desktop"}`}
      initialText={draft}
      onChange={updateDraft}
      labelledBy="telemt-toml-editor-title"
    />
  );

  return (
    <div className="flex flex-col gap-3" data-testid="toml-settings-panel">
      <Notice tone="info" title={s.server.config.toml.projectionTitle}>
        <p className="text-meta leading-relaxed text-text-muted">{initial.note}</p>
        <p className="text-micro text-text-faint">{s.server.config.toml.projectionDetail}</p>
      </Notice>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionLabel>{s.server.config.toml.kicker}</SectionLabel>
          <h2 id="telemt-toml-editor-title" className="mt-1 text-[17px] font-bold text-text">{s.server.config.toml.title}</h2>
          <p className="mt-1 text-meta text-text-muted">{initial.source_sections.join(" · ")} · revision {initial.revision.slice(0, 8)}</p>
        </div>
        {!isDesktop && <Button variant="secondary" onClick={() => setMobileOpen(true)}>{s.server.config.toml.openEditor}</Button>}
      </div>

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
        <div className="min-h-0 flex-1 overflow-hidden">{editor}</div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border pt-3 pb-safe">
          <Button variant="secondary" onClick={() => setMobileOpen(false)}>{s.common.cancel}</Button>
          <Button onClick={() => { setMobileOpen(false); validate(); }} disabled={!dirty || previewMutation.isPending}>{s.server.config.toml.doneAndValidate}</Button>
        </div>
      </Sheet>

      {previewCurrent && <TOMLPreview preview={previewCurrent} />}

      {result && (
        <PatchResultNotice
          result={result}
          canRestartTelemt={canRestartTelemt}
          onReloadNow={() => reloadMutation.mutate({ body: { mode: "instant" } })}
          onRestartNow={() => restartMutation.mutate({})}
          reloadPending={reloadMutation.isPending}
          restartPending={restartMutation.isPending}
        />
      )}

      <Card className="sticky bottom-2 z-10 flex flex-col gap-3 border border-border/80 bg-surface/95 shadow-xl backdrop-blur lg:flex-row lg:items-end lg:justify-between">
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
