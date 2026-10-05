import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStrings } from "../../i18n";
import { apiErrorCode, apiErrorMessage } from "../../people/apiError";
import { acknowledgeSubmitted, discardToRemote, type SubmittedDraft } from "../../lib/draftSession";
import { useDraftSession } from "../../lib/draftSessionReact";
import { DraftSessionActions } from "../../lib/draftSessionActions";
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
  reloadTelemtMutation,
  restartTelemtServiceMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import { patchTelemtConfigToml, previewTelemtConfigToml } from "../../lib/api/generated/sdk.gen";
import type {
  TelemtConfigPatchResult,
  TelemtConfigToml,
  TelemtConfigTomlPreview,
  PatchTelemtConfigTomlError,
  PreviewTelemtConfigTomlError,
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
  if (!query.data) {
    return <ErrorState message={query.error ? apiErrorMessage(query.error, s) : s.common.error} onRetry={() => query.refetch()} />;
  }
  return <TomlSettingsSession initial={query.data} canRestartTelemt={canRestartTelemt} onApplied={onApplied} />;
}

const equalText = (a: string, b: string) => a === b;

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
  const { session, update, current } = useDraftSession("telemt-toml", { value: initial.toml_projection, revision: initial.revision }, equalText);
  const draft = session.draft;
  const [validatedDraft, setValidatedDraft] = useState<SubmittedDraft<string> | null>(null);
  const [preview, setPreview] = useState<TelemtConfigTomlPreview | null>(null);
  const [result, setResult] = useState<TelemtConfigPatchResult | null>(null);
  const [reloadPolicy, setReloadPolicy] = useState<ReloadPolicyState>(DEFAULT_RELOAD_POLICY);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const requestSequence = useRef(0);
  const activePreview = useRef<number | null>(null);
  const activeSave = useRef<number | null>(null);
  useEffect(() => () => { activePreview.current = null; activeSave.current = null; }, []);

  const dirty = draft !== session.baseline.value;
  const previewCurrent = validatedDraft?.value === draft && validatedDraft.revision === session.baseline.revision ? preview : null;
  const changed = previewCurrent?.changed_paths.length ?? 0;

  const previewMutation = useMutation({
    mutationFn: async (submitted: SubmittedDraft<string>) => {
      const { data } = await previewTelemtConfigToml({ headers: { "If-Match": submitted.revision! }, body: { toml_projection: submitted.value }, throwOnError: true });
      return data;
    },
    onSuccess: (next, submitted) => {
      if (activePreview.current !== submitted.requestId || current.current.sessionKey !== submitted.sessionKey) return;
      activePreview.current = null;
      setPreview(next);
      setValidatedDraft(submitted);
      setResult(null);
    },
    onError: (error: PreviewTelemtConfigTomlError, submitted) => {
      if (activePreview.current !== submitted.requestId) return;
      activePreview.current = null;
      setPreview(null);
      setValidatedDraft(null);
      if (apiErrorCode(error) === "revision_conflict") { setConflict(true); void queryClient.invalidateQueries({ queryKey: getTelemtConfigTomlQueryKey() }); }
      pushToast(apiErrorMessage(error, s), "error");
    },
  });

  const patchMutation = useMutation({
    mutationFn: async (submitted: SubmittedDraft<string> & { reloadPolicy: ReloadPolicyState }) => {
      const { data } = await patchTelemtConfigToml({ headers: { "If-Match": submitted.revision! }, query: toPatchReloadQuery(submitted.reloadPolicy), body: { toml_projection: submitted.value }, throwOnError: true });
      return data;
    },
    onSuccess: async (next, submitted) => {
      if (activeSave.current !== submitted.requestId || current.current.sessionKey !== submitted.sessionKey) return;
      activeSave.current = null;
      const confirmed = update((state) => acknowledgeSubmitted(state, submitted, { value: submitted.value, revision: next.revision }, equalText));
      recordPendingChanges(next);
      setResult(confirmed.draft === confirmed.baseline.value && !confirmed.remote ? next : null);
      setPreview(null);
      setValidatedDraft(null);
      setConflict(false);
      queryClient.invalidateQueries({ queryKey: getTelemtConfigTomlQueryKey() });
      queryClient.invalidateQueries({ queryKey: getTelemtConfigQueryKey() });
      await onApplied?.(next);
    },
    onError: (error: PatchTelemtConfigTomlError, submitted) => {
      if (activeSave.current !== submitted.requestId) return;
      activeSave.current = null;
      if (apiErrorCode(error) === "revision_conflict") { setConflict(true); void queryClient.invalidateQueries({ queryKey: getTelemtConfigTomlQueryKey() }); }
      pushToast(apiErrorMessage(error, s), "error");
    },
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
    update((state) => state.draft === next ? state : { ...state, draft: next });
    setValidatedDraft(null);
    setPreview(null);
    setResult(null);
  }

  function validate() {
    if (activePreview.current !== null || activeSave.current !== null) return;
    const submitted = { sessionKey: session.sessionKey, value: draft, revision: session.baseline.revision, requestId: ++requestSequence.current };
    activePreview.current = submitted.requestId;
    previewMutation.mutate(submitted);
  }

  function save() {
    if (!previewCurrent || changed === 0 || activeSave.current !== null) return;
    const submitted = { sessionKey: session.sessionKey, value: draft, revision: session.baseline.revision, requestId: ++requestSequence.current, reloadPolicy: { ...reloadPolicy } };
    activeSave.current = submitted.requestId;
    patchMutation.mutate(submitted);
  }

  function discard() {
    update(discardToRemote); setConflict(false); setPreview(null); setValidatedDraft(null); setResult(null);
  }
  async function copyDraft() {
    try { await navigator.clipboard.writeText(current.current.draft); pushToast(s.server.config.toml.copied, "ok"); }
    catch { pushToast(s.common.error, "error"); }
  }

  const editor = (
    <TomlConfigEditor
      initialText={draft}
      onChange={updateDraft}
      labelledBy="telemt-toml-editor-title"
    />
  );

  return (
    <div className="flex flex-col gap-3" data-testid="toml-settings-panel">
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
