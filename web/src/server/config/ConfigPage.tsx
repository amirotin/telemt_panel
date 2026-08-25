import { Suspense, lazy, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { ru, errorMessage } from "../../i18n/ru";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { SectionLabel } from "../../ui/SectionLabel";
import { ErrorState } from "../../ui/ErrorState";
import { Gated } from "../../caps/Gated";
import { Card } from "../../ui/Card";
import { Notice } from "../Notice";
import { pushToast } from "../../ui/Toast";
import { apiErrorMessage } from "../../people/apiError";
import { useIsDesktop } from "../useIsDesktop";
import { QuickSettingsForm } from "./QuickSettingsForm";
import { ReadOnlyJsonView } from "./ReadOnlyJsonView";
import { ReloadPolicyPicker } from "./ReloadPolicyPicker";
import { ReloadStepper } from "./ReloadStepper";
import { PatchResultNotice } from "./PatchResultNotice";
import { ConflictBanner } from "./ConflictBanner";
import { useConfigEditor } from "./useConfigEditor";
import { useReloadPolling } from "./useReloadPolling";
import { buildConfigPatch } from "./configPatch.helpers";
import { diffChangedSectionKeys } from "./configConflict.helpers";
import { rebaseEdits } from "./rebaseEdits";
import {
  DEFAULT_RELOAD_POLICY,
  toPatchReloadQuery,
  type ReloadPolicyState,
} from "./reloadPolicy";
import {
  getTelemtConfigOptions,
  getTelemtConfigQueryKey,
  getHostOptions,
  patchTelemtConfigMutation,
  reloadTelemtMutation,
  restartTelemtServiceMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import { getTelemtConfig } from "../../lib/api/generated/sdk.gen";
import type {
  TelemtConfig,
  TelemtConfigPatchResult,
} from "../../lib/api/generated/types.gen";

const RawConfigEditor = lazy(() =>
  import("./RawConfigEditor").then((m) => ({ default: m.RawConfigEditor })),
);

type Tab = "quick" | "raw";

interface ConflictState {
  changedKeys: string[];
  fresh: TelemtConfig;
  /** freshBase with the admin's pending patch reapplied on top (rebaseEdits.ts) — what the working copy becomes if "reapply" is chosen. */
  rebased: Record<string, unknown>;
  /** "section.key" paths where the admin's pending edit and the server's own change collide — [] means reapplying is unambiguous. */
  overlapping: string[];
}

export function ConfigPage() {
  const queryClient = useQueryClient();
  const configQuery = useQuery(getTelemtConfigOptions());
  const hostQuery = useQuery(getHostOptions());
  const editor = useConfigEditor(configQuery.data);

  const [tab, setTab] = useState<Tab>("quick");
  const [reloadPolicy, setReloadPolicy] = useState<ReloadPolicyState>(
    DEFAULT_RELOAD_POLICY,
  );
  const [rawIssue, setRawIssue] = useState<
    | { kind: "parse_error" }
    | { kind: "unsafe_integer"; tokens: string[] }
    | null
  >(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [patchResult, setPatchResult] =
    useState<TelemtConfigPatchResult | null>(null);
  const [activeReloadId, setActiveReloadId] = useState<number | null>(null);
  const [patchErrorCode, setPatchErrorCode] = useState<string | null>(null);
  // Snapshot of the `sections` patch actually sent with the in-flight
  // PATCH — read from a ref, not recomputed from `editor.edited`, inside
  // onError: the admin can keep typing into the form while the request is
  // in flight, and TanStack Query's onError always calls the LATEST
  // render's callback, so recomputing here would rebase against edits
  // made *after* the request that actually failed, not the ones that were
  // actually sent.
  const pendingPatchRef = useRef<Record<string, unknown>>({});

  const isDesktop = useIsDesktop();
  const canRestartTelemt = hostQuery.data?.caps.restart_telemt ?? false;

  const reloadStatusQuery = useReloadPolling(activeReloadId);

  const patchMutation = useMutation({
    ...patchTelemtConfigMutation(),
    onSuccess: async (result) => {
      setPatchResult(result);
      setConflict(null);
      setPatchErrorCode(null);
      if (result.reload) setActiveReloadId(result.reload.reload_id);
      queryClient.invalidateQueries({ queryKey: getTelemtConfigQueryKey() });
      // Re-baseline to a fresh revision explicitly (useConfigEditor never
      // auto-reseeds from the query cache — see that hook's own doc
      // comment) so the next PATCH's If-Match sends the revision this
      // PATCH just produced, not the stale one it started from.
      const fresh = await getTelemtConfig();
      if (fresh.data) editor.seed(fresh.data);
    },
    onError: async (err) => {
      if (err.code === "revision_conflict" && editor.baseline) {
        const fresh = await getTelemtConfig();
        if (fresh.data) {
          const changedKeys = diffChangedSectionKeys(
            editor.baseline.sections,
            fresh.data.sections,
          );
          const { edited: rebased, overlapping } = rebaseEdits(
            fresh.data.sections,
            pendingPatchRef.current,
            changedKeys,
          );
          setConflict({ changedKeys, fresh: fresh.data, rebased, overlapping });
        }
        return;
      }
      // Every other failure — read_only, the 422 "not editable"/ambiguous-
      // listeners codes, a stray network error — renders as a persistent
      // inline banner (below), not just a toast: read_only in particular
      // describes an ongoing state (Telemt stays read-only until its own
      // config changes), so a 4s toast alone would under-communicate it.
      setPatchErrorCode(err.code ?? "internal_error");
    },
  });

  // submitPatch is the one place that actually fires the mutation — used
  // by both `save()` (the normal path) and the conflict banner's
  // "reapply" action (a rebase-then-retry, so a single click really does
  // retry rather than just repositioning for a second manual Save).
  function submitPatch(revision: string, sections: Record<string, unknown>) {
    pendingPatchRef.current = sections;
    patchMutation.mutate({
      headers: { "If-Match": revision },
      query: toPatchReloadQuery(reloadPolicy),
      body: { sections },
    });
  }

  const reloadNowMutation = useMutation({
    ...reloadTelemtMutation(),
    onSuccess: (accepted) => setActiveReloadId(accepted.reload_id),
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  const restartMutation = useMutation({
    ...restartTelemtServiceMutation(),
    onSuccess: () => pushToast(ru.server.platform.restarted, "ok"),
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  if (configQuery.isPending) {
    return (
      <ServerShell title={ru.server.config.title}>
        <Skeleton className="h-40 w-full" />
      </ServerShell>
    );
  }

  if (configQuery.isError) {
    const code = configQuery.error?.code ?? "internal_error";
    if (code === "capability_unavailable") {
      return (
        <ServerShell title={ru.server.config.title}>
          <Gated
            enabled={false}
            reason={configQuery.error?.message}
            hint="config_api"
          />
        </ServerShell>
      );
    }
    return (
      <ServerShell title={ru.server.config.title}>
        <ErrorState
          message={errorMessage(code)}
          onRetry={() => configQuery.refetch()}
        />
      </ServerShell>
    );
  }

  if (!editor.baseline || !editor.edited) {
    return (
      <ServerShell title={ru.server.config.title}>
        <Skeleton className="h-40 w-full" />
      </ServerShell>
    );
  }

  const patch = buildConfigPatch(editor.baseline.sections, editor.edited);
  const hasChanges = Object.keys(patch).length > 0;

  function save() {
    if (!editor.baseline || rawIssue) return;
    // Clear any stale notice from a *previous* save before starting a new
    // one — otherwise a lingering success banner (changed keys, a reload
    // stepper stuck on an old run) sits next to this new in-flight save,
    // implying it already finished.
    setPatchErrorCode(null);
    setPatchResult(null);
    setActiveReloadId(null);
    submitPatch(editor.baseline.revision, patch);
  }

  return (
    <ServerShell title={ru.server.config.title}>
      {conflict && (
        <ConflictBanner
          changedKeys={conflict.changedKeys}
          overlapping={conflict.overlapping}
          pending={patchMutation.isPending}
          onReapply={() => {
            const rebasedConfig: TelemtConfig = {
              revision: conflict.fresh.revision,
              sections: conflict.rebased,
            };
            const retryPatch = buildConfigPatch(
              conflict.fresh.sections,
              conflict.rebased,
            );
            editor.seed(rebasedConfig);
            setConflict(null);
            // Nothing left to send only when the admin's pending edit
            // turned out to already match the fresh server state exactly
            // (rare) — otherwise this is the actual retry with the
            // corrected If-Match, not just a reposition for another click.
            if (Object.keys(retryPatch).length > 0) {
              submitPatch(rebasedConfig.revision, retryPatch);
            }
          }}
          onDiscard={() => {
            editor.seed(conflict.fresh);
            setConflict(null);
          }}
        />
      )}

      {patchErrorCode && (
        <Notice tone="error" title={errorMessage(patchErrorCode)} />
      )}

      {patchResult && (
        <PatchResultNotice
          result={patchResult}
          canRestartTelemt={canRestartTelemt}
          reloadPending={reloadNowMutation.isPending}
          restartPending={restartMutation.isPending}
          onReloadNow={() =>
            reloadNowMutation.mutate({ body: { mode: "instant" } })
          }
          onRestartNow={() => restartMutation.mutate({})}
        />
      )}

      {activeReloadId !== null && (
        <Card>
          <ReloadStepper
            status={reloadStatusQuery.data}
            errorCode={reloadStatusQuery.error?.code}
          />
        </Card>
      )}

      <div className="flex w-fit gap-1.5" role="tablist">
        {(["quick", "raw"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              "inline-flex h-[34px] shrink-0 items-center rounded-full px-3.5 text-xs font-semibold transition-colors",
              tab === name
                ? "bg-text text-bg"
                : "bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text",
            )}
          >
            {ru.server.config.tabs[name]}
          </button>
        ))}
      </div>

      {tab === "quick" ? (
        <QuickSettingsForm
          sections={editor.edited}
          onChange={editor.setEdited}
        />
      ) : isDesktop ? (
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <div className="flex flex-col gap-2">
            <SectionLabel>{ru.server.config.rawEditorTitle}</SectionLabel>
            <RawConfigEditor
              initialText={JSON.stringify(editor.edited, null, 2)}
              onChange={(result) => {
                if (result.status === "ok") {
                  setRawIssue(null);
                  editor.setEdited(result.value);
                } else if (result.status === "parse_error") {
                  setRawIssue({ kind: "parse_error" });
                } else {
                  setRawIssue({
                    kind: "unsafe_integer",
                    tokens: result.tokens,
                  });
                }
              }}
            />
            {rawIssue?.kind === "parse_error" && (
              <Notice tone="error" title={ru.server.config.rawParseError} />
            )}
            {rawIssue?.kind === "unsafe_integer" && (
              <Notice tone="error" title={ru.server.config.rawUnsafeInteger}>
                <p className="font-mono text-meta text-text">
                  {rawIssue.tokens.join(", ")}
                </p>
              </Notice>
            )}
          </div>
        </Suspense>
      ) : (
        <ReadOnlyJsonView sections={editor.edited} />
      )}

      <Card className="flex flex-wrap items-end justify-between gap-3">
        <ReloadPolicyPicker value={reloadPolicy} onChange={setReloadPolicy} />
        <div className="flex items-center gap-2.5">
          {!hasChanges && (
            <span className="text-micro text-text-faint">
              {ru.server.config.noChanges}
            </span>
          )}
          <Button
            onClick={save}
            disabled={
              !hasChanges || rawIssue !== null || patchMutation.isPending
            }
          >
            {patchMutation.isPending
              ? ru.server.config.saving
              : ru.server.config.save}
          </Button>
        </div>
      </Card>
    </ServerShell>
  );
}
