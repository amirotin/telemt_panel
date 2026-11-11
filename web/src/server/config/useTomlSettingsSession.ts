import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useStrings } from "../../i18n";
import { apiErrorCode, apiErrorMessage } from "../../people/apiError";
import { acknowledgeSubmitted, discardToRemote, type SubmittedDraft } from "../../lib/draftSession";
import { invalidateTelemtConfigCaches } from "../../lib/invalidateTelemtConfigCaches";
import { useDraftSession } from "../../lib/draftSessionReact";
import { pushToast } from "../../ui/Toast";
import {
  getTelemtConfigTomlOptions,
  reloadTelemtMutation,
  restartTelemtServiceMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import { patchTelemtConfigToml, previewTelemtConfigToml } from "../../lib/api/generated/sdk.gen";
import type { TelemtConfigPatchResult, TelemtConfigTomlPreview, PatchTelemtConfigTomlError, PreviewTelemtConfigTomlError } from "../../lib/api/generated/types.gen";
import { nativePatchResult, validationMatches } from "./configPreflight";
import { recordPendingChanges } from "./pendingChanges";
import { DEFAULT_RELOAD_POLICY, toPatchReloadQuery, type ReloadPolicyState } from "./reloadPolicy";

const equalText = (a: string, b: string) => a === b;

// Own the lightweight session above the conditional editor view, so tab
// changes cannot discard drafts or cancel ownership of an in-flight request.
export function useTomlSettingsSession({ enabled, onApplied, onReloadAccepted, readOnly = false }: {
  readOnly?: boolean;
  onReloadAccepted?: (reloadId: number) => void;
  enabled: boolean;
  onApplied?: (result: TelemtConfigPatchResult) => void | Promise<void>;
}) {
  const query = useQuery({ ...getTelemtConfigTomlOptions(), enabled });
  const s = useStrings();
  const queryClient = useQueryClient();
  const [writePending, setWritePending] = useState(false);
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const { session, update, current } = useDraftSession("telemt-toml", { value: query.data?.toml_projection ?? "", revision: query.data?.revision ?? null }, equalText, writePending || unknownOutcome);
  const draft = session.draft;
  const [validatedDraft, setValidatedDraft] = useState<(SubmittedDraft<string> & { reloadPolicy: ReloadPolicyState }) | null>(null);
  const [preview, setPreview] = useState<TelemtConfigTomlPreview | null>(null);
  const [result, setResult] = useState<TelemtConfigPatchResult | null>(null);
  const [reloadPolicy, setReloadPolicy] = useState<ReloadPolicyState>(DEFAULT_RELOAD_POLICY);
  const [conflict, setConflict] = useState(false);
  const requestSequence = useRef(0);
  const activePreview = useRef<number | null>(null);
  const activeSave = useRef<number | null>(null);
  useEffect(() => () => { activePreview.current = null; activeSave.current = null; }, []);

  const dirty = draft !== session.baseline.value;
  const previewCurrent = validatedDraft?.value === draft && validatedDraft.revision === session.baseline.revision && JSON.stringify(validatedDraft.reloadPolicy) === JSON.stringify(reloadPolicy) ? preview : null;
  const changed = previewCurrent?.changed_paths.length ?? 0;

  const previewMutation = useMutation({
    mutationFn: async (submitted: SubmittedDraft<string> & { reloadPolicy: ReloadPolicyState }) => {
      const { data } = await previewTelemtConfigToml({ headers: { "If-Match": submitted.revision! }, body: { toml_projection: submitted.value }, query: toPatchReloadQuery(submitted.reloadPolicy), throwOnError: true });
      if (!data || data.revision !== submitted.revision || !Array.isArray(data.changed_paths)) throw { code: "telemt_api_error" };
      const validation = data.validation;
      if (validation && (!validationMatches(validation, submitted.revision!) || data.runtime_match !== validation.runtime.runtime_match)) throw { code: "telemt_api_error" };
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
      if (apiErrorCode(error) === "revision_conflict") {
        const latest = current.current;
        setConflict(latest.draft !== latest.baseline.value);
        // This controller also receives late outcomes while its view is
        // unmounted and the query is disabled on another tab.
        void query.refetch();
      }
      pushToast(apiErrorMessage(error, s), "error");
    },
  });

  const patchMutation = useMutation({
    retry: false,
    mutationFn: async (submitted: SubmittedDraft<string> & { reloadPolicy: ReloadPolicyState; runtimeMatch?: string; validation?: TelemtConfigTomlPreview["validation"] }) => {
      const { data } = await patchTelemtConfigToml({ headers: { "If-Match": submitted.revision!, ...(submitted.runtimeMatch ? { "If-Runtime-Match": submitted.runtimeMatch } : {}) }, query: toPatchReloadQuery(submitted.reloadPolicy), body: { toml_projection: submitted.value }, throwOnError: true });
      return data;
    },
    onSuccess: async (rawNext, submitted) => {
      const next = nativePatchResult(rawNext, submitted.validation);
      if (activeSave.current !== submitted.requestId || current.current.sessionKey !== submitted.sessionKey) return;
      activeSave.current = null;
      setWritePending(false);
      const confirmed = update((state) => acknowledgeSubmitted(state, submitted, { value: submitted.value, revision: next.revision }, equalText));
      recordPendingChanges(rawNext);
      setResult(confirmed.draft === confirmed.baseline.value && !confirmed.remote ? next : null);
      setPreview(null);
      setValidatedDraft(null);
      setConflict(false);
      setUnknownOutcome(false);
      void invalidateTelemtConfigCaches(queryClient);
      await onApplied?.(next);
    },
    onError: (error: PatchTelemtConfigTomlError, submitted) => {
      if (activeSave.current !== submitted.requestId) return;
      activeSave.current = null;
      setWritePending(false);
      const code = apiErrorCode(error) ?? "telemt_config_outcome_unknown";
      setPreview(null);
      setValidatedDraft(null);
      if (code === "telemt_config_outcome_unknown") {
        setUnknownOutcome(true);
        setPreview(null);
        setValidatedDraft(null);
      }
      if (code === "revision_conflict") {
        const latest = current.current;
        const dirty = latest.draft !== latest.baseline.value;
        // A rejected write can release a clean session's protected GET,
        // including a snapshot already received while PATCH was pending.
        if (!dirty && latest.remote) update(discardToRemote);
        setUnknownOutcome(false);
        setConflict(dirty);
        void query.refetch();
      }
      pushToast(errorMessage(s, code, error?.message), "error");
    },
  });

  const reloadMutation = useMutation({
    ...reloadTelemtMutation(),
    onSuccess: (accepted) => { onReloadAccepted?.(accepted.reload_id); pushToast(s.server.config.toml.reloadAccepted, "ok"); },
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });
  const restartMutation = useMutation({
    ...restartTelemtServiceMutation(),
    onSuccess: () => pushToast(s.server.config.toml.restartAccepted, "ok"),
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });

  function updateDraft(next: string) {
    const latest = update((state) => state.draft === next ? state : { ...state, draft: next });
    if (latest.draft === latest.baseline.value && !latest.remote) setConflict(false);
    setValidatedDraft(null);
    setPreview(null);
    setResult(null);
  }

  function validate() {
    if (!session.baseline.revision || activePreview.current !== null || activeSave.current !== null) return;
    const submitted = { sessionKey: session.sessionKey, value: draft, revision: session.baseline.revision, requestId: ++requestSequence.current, reloadPolicy: { ...reloadPolicy } };
    activePreview.current = submitted.requestId;
    previewMutation.mutate(submitted);
  }

  function save() {
    if (!previewCurrent || changed === 0 || activeSave.current !== null || readOnly) return;
    const submitted = { sessionKey: session.sessionKey, value: draft, revision: session.baseline.revision, requestId: ++requestSequence.current, reloadPolicy: { ...reloadPolicy }, runtimeMatch: previewCurrent.runtime_match, validation: previewCurrent.validation };
    activeSave.current = submitted.requestId;
    setWritePending(true);
    patchMutation.mutate(submitted);
  }

  function discard() {
    const cancelPreview = activePreview.current !== null;
    if (cancelPreview) {
      activePreview.current = null;
      previewMutation.reset();
    }
    update(discardToRemote); setConflict(false); setUnknownOutcome(false); setPreview(null); setValidatedDraft(null); setResult(null);
    if (cancelPreview) void query.refetch();
  }
  async function copyDraft() {
    try { await navigator.clipboard.writeText(current.current.draft); pushToast(s.server.config.toml.copied, "ok"); }
    catch { pushToast(s.common.error, "error"); }
  }

  return {
    query, session, draft, dirty, previewCurrent, changed, result, readOnly,
    reloadPolicy, setReloadPolicy, conflict, unknownOutcome,
    previewMutation, patchMutation, reloadMutation, restartMutation,
    updateDraft, validate, save, discard, copyDraft,
    blocked: dirty || !!session.remote || conflict || unknownOutcome || previewMutation.isPending || patchMutation.isPending,
  };
}

export type TomlSettingsController = ReturnType<typeof useTomlSettingsSession>;
