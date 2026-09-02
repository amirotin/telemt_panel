import { Suspense, lazy, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { errorMessage, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { Gated } from "../../caps/Gated";
import { Card } from "../../ui/Card";
import { Notice } from "../Notice";
import { pushToast } from "../../ui/Toast";
import { apiErrorMessage } from "../../people/apiError";
import { StructuredSettingsForm } from "./StructuredSettingsForm";
import { ReloadPolicyPicker } from "./ReloadPolicyPicker";
import { ReloadStepper } from "./ReloadStepper";
import { PatchResultNotice } from "./PatchResultNotice";
import { recordPendingChanges } from "./pendingChanges";
import { ConflictBanner } from "./ConflictBanner";
import { useConfigEditor, type ConfigSnapshot } from "./useConfigEditor";
import { useReloadPolling } from "./useReloadPolling";
import { buildConfigPatch } from "./configPatch.helpers";
import { diffChangedSectionKeys } from "./configConflict.helpers";
import { rebaseEdits } from "./rebaseEdits";
import { preserveLateConfigEdits } from "./configSave.helpers";
import { ConfigSavePreview } from "./ConfigSavePreview";
import {
  DEFAULT_RELOAD_POLICY,
  toPatchReloadQuery,
  type ReloadPolicyState,
} from "./reloadPolicy";
import {
  getTelemtConfigOptions,
  getTelemtConfigCatalogOptions,
  getTelemtConfigTomlQueryKey,
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

const TomlSettingsPanel = lazy(() =>
  import("./TomlSettingsPanel").then((m) => ({ default: m.TomlSettingsPanel })),
);

type Tab = "normal" | "advanced" | "toml";

interface ConflictState {
  changedKeys: string[];
  fresh: TelemtConfig;
  /** freshBase with the admin's pending patch reapplied on top (rebaseEdits.ts) — what the working copy becomes if "reapply" is chosen. */
  rebased: Record<string, unknown>;
  /** "section.key" paths where the admin's pending edit and the server's own change collide — [] means reapplying is unambiguous. */
  overlapping: string[];
}

export function ConfigPage() {
  const s = useStrings();
  const queryClient = useQueryClient();
  const configQuery = useQuery(getTelemtConfigOptions());
  const catalogQuery = useQuery(getTelemtConfigCatalogOptions());
  const hostQuery = useQuery(getHostOptions());
  const editor = useConfigEditor(configQuery.data);

  const [tab, setTab] = useState<Tab>("normal");
  const [reloadPolicy, setReloadPolicy] = useState<ReloadPolicyState>(
    DEFAULT_RELOAD_POLICY,
  );
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [patchResult, setPatchResult] =
    useState<TelemtConfigPatchResult | null>(null);
  const [activeReloadId, setActiveReloadId] = useState<number | null>(null);
  const [patchErrorCode, setPatchErrorCode] = useState<string | null>(null);
  const [savePreviewOpen, setSavePreviewOpen] = useState(false);
  // Full working-copy snapshot corresponding to the in-flight PATCH. A
  // later keystroke is diffed from this snapshot after success and rebased
  // over Telemt's fresh response instead of being silently discarded.
  const pendingDraftRef = useRef<Record<string, unknown>>({});

  const canRestartTelemt = hostQuery.data?.caps.restart_telemt ?? false;

  const reloadStatusQuery = useReloadPolling(activeReloadId);

  const patchMutation = useMutation({
    ...patchTelemtConfigMutation(),
    onSuccess: async (result) => {
      setSavePreviewOpen(false);
      setPatchResult(result);
      // Telemt reports "not applied yet" only in this response, so the
      // panel remembers it for Сводка's banner (pendingChanges.ts).
      recordPendingChanges(result);
      setConflict(null);
      setPatchErrorCode(null);
      if (result.reload) setActiveReloadId(result.reload.reload_id);
      queryClient.invalidateQueries({ queryKey: getTelemtConfigQueryKey() });
      queryClient.invalidateQueries({ queryKey: getTelemtConfigTomlQueryKey() });
      // Re-baseline to a fresh revision explicitly (useConfigEditor never
      // auto-reseeds from the query cache — see that hook's own doc
      // comment) so the next PATCH's If-Match sends the revision this
      // PATCH just produced, not the stale one it started from.
      const fresh = await getTelemtConfig();
      if (fresh.data) {
        const latestDraft = editor.getEdited() ?? pendingDraftRef.current;
        const workingCopy = preserveLateConfigEdits(
          fresh.data.sections,
          pendingDraftRef.current,
          latestDraft,
        );
        editor.seed(fresh.data, workingCopy);
      } else {
        // The write already succeeded, so never leave If-Match on the old
        // revision just because the follow-up GET failed. The submitted
        // full draft is a safe fallback baseline until a later refetch can
        // provide Telemt's normalized representation.
        const latestDraft = editor.getEdited() ?? pendingDraftRef.current;
        editor.seed(
          { revision: result.revision, sections: pendingDraftRef.current },
          latestDraft,
        );
      }
    },
    onError: async (err) => {
      setSavePreviewOpen(false);
      if (err.code === "revision_conflict" && editor.baseline) {
        const fresh = await getTelemtConfig();
        if (fresh.data) {
          const changedKeys = diffChangedSectionKeys(
            editor.baseline.sections,
            fresh.data.sections,
          );
          const latestDraft = editor.getEdited() ?? editor.baseline.sections;
          const latestPatch = buildConfigPatch(
            editor.baseline.sections,
            latestDraft,
          );
          const { edited: rebased, overlapping } = rebaseEdits(
            fresh.data.sections,
            latestPatch,
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
  function submitPatch(
    revision: string,
    sections: Record<string, unknown>,
    draft: Record<string, unknown>,
  ) {
    pendingDraftRef.current = draft;
    patchMutation.mutate({
      headers: { "If-Match": revision },
      query: toPatchReloadQuery(reloadPolicy),
      body: { sections },
    });
  }

  const reloadNowMutation = useMutation({
    ...reloadTelemtMutation(),
    onSuccess: (accepted) => setActiveReloadId(accepted.reload_id),
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const restartMutation = useMutation({
    ...restartTelemtServiceMutation(),
    onSuccess: () => pushToast(s.server.platform.restarted, "ok"),
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  if (configQuery.isPending || catalogQuery.isPending) {
    return (
      <ServerShell title={s.server.config.title}>
        <Skeleton className="h-40 w-full" />
      </ServerShell>
    );
  }

  if (configQuery.isError) {
    const code = configQuery.error?.code ?? "internal_error";
    if (code === "capability_unavailable") {
      return (
        <ServerShell title={s.server.config.title}>
          <Gated
            enabled={false}
            reason={configQuery.error?.message}
            hint="config_api"
          />
        </ServerShell>
      );
    }
    return (
      <ServerShell title={s.server.config.title}>
        <ErrorState
          message={errorMessage(s, code)}
          onRetry={() => configQuery.refetch()}
        />
      </ServerShell>
    );
  }

  if (catalogQuery.isError) {
    return (
      <ServerShell title={s.server.config.title}>
        <ErrorState
          message={errorMessage(
            s,
            (catalogQuery.error as { code?: string } | null)?.code ?? "internal_error",
          )}
          onRetry={() => catalogQuery.refetch()}
        />
      </ServerShell>
    );
  }

  if (!editor.baseline || !editor.edited || !catalogQuery.data) {
    return (
      <ServerShell title={s.server.config.title}>
        <Skeleton className="h-40 w-full" />
      </ServerShell>
    );
  }

  const patch = buildConfigPatch(editor.baseline.sections, editor.edited);
  const hasChanges = Object.keys(patch).length > 0;
  const changedCount = countPatchChanges(patch);

  function save() {
    if (!editor.baseline || !editor.edited || !hasChanges) return;
    setSavePreviewOpen(true);
  }

  function applyPreviewedChanges() {
    if (!editor.baseline || !editor.edited) return;
    // Clear any stale notice from a *previous* save before starting a new
    // one — otherwise a lingering success banner (changed keys, a reload
    // stepper stuck on an old run) sits next to this new in-flight save,
    // implying it already finished.
    setPatchErrorCode(null);
    setPatchResult(null);
    setActiveReloadId(null);
    submitPatch(editor.baseline.revision, patch, editor.edited);
  }

  return (
    <ServerShell title={s.server.config.title}>
      {conflict && (
        <ConflictBanner
          changedKeys={conflict.changedKeys}
          overlapping={conflict.overlapping}
          pending={patchMutation.isPending}
          onReapply={() => {
            const rebasedConfig: ConfigSnapshot = {
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
              submitPatch(rebasedConfig.revision, retryPatch, conflict.rebased);
            }
          }}
          onDiscard={() => {
            editor.seed(conflict.fresh);
            setConflict(null);
          }}
        />
      )}

      {patchErrorCode && (
        <Notice tone="error" title={errorMessage(s, patchErrorCode)} />
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

      <Card className="relative overflow-clip p-0">
        <div className="flex min-h-[66px] flex-wrap items-center justify-between gap-2 border-b border-border px-2.5 py-2.5 sm:px-4">
          <div className="grid w-full grid-cols-3 rounded-xl border border-border bg-bg/35 p-1 sm:max-w-[620px]" role="tablist">
            {(["normal", "advanced", "toml"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                disabled={name === "toml" && hasChanges}
                title={name === "toml" && hasChanges ? s.server.config.tomlBlockedByDraft : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center justify-center rounded-lg px-2 text-meta font-semibold transition-colors",
                  tab === name
                    ? "bg-accent/25 text-text shadow-sm"
                    : "text-text-muted hover:bg-surface-2 hover:text-text",
                  name === "toml" && hasChanges && "cursor-not-allowed opacity-45",
                )}
              >
                {s.server.config.tabs[name]}
              </button>
            ))}
          </div>
          <span className="hidden text-micro text-text-faint xl:inline">
            {s.server.config.catalogVersion
              .replace("{version}", catalogQuery.data.version)
              .replace("{count}", String(catalogQuery.data.fields.length))}
          </span>
        </div>

        {tab === "normal" || tab === "advanced" ? (
          <StructuredSettingsForm
            catalog={catalogQuery.data}
            sections={editor.edited}
            mode={tab}
            changedCount={changedCount}
            onChange={(next) => {
              setPatchResult(null);
              setPatchErrorCode(null);
              editor.setEdited(next);
            }}
          />
        ) : (
          <div className="p-3 sm:p-4">
            <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
              <TomlSettingsPanel
                canRestartTelemt={canRestartTelemt}
                onApplied={async (result) => {
                  const fresh = await getTelemtConfig();
                  if (fresh.data) editor.seed(fresh.data);
                  setPatchResult(result);
                }}
              />
            </Suspense>
          </div>
        )}

        {tab !== "toml" && (
          <div data-testid="config-save-bar" className="relative z-10 flex flex-wrap items-center justify-between gap-2 border-t border-border-strong bg-surface/95 px-3 py-2.5 backdrop-blur-xl lg:sticky lg:bottom-0 lg:items-end lg:gap-3 sm:px-4">
            <div className="flex min-h-11 items-center gap-2.5">
              <span className={cn("size-2 rounded-full", hasChanges ? "bg-warn" : "bg-ok")} />
              <span>
                <strong className="block text-micro text-text sm:text-meta">
                  {hasChanges
                    ? s.server.config.catalog.draftCount.replace("{count}", String(changedCount))
                    : s.server.config.noChanges}
                </strong>
                <small className="hidden text-micro text-text-faint sm:block">Revision {editor.baseline.revision.slice(0, 8)}</small>
              </span>
            </div>
            <div className="order-3 w-full lg:order-none lg:w-auto">
              <ReloadPolicyPicker value={reloadPolicy} onChange={setReloadPolicy} />
            </div>
            <div className="ml-auto flex items-center gap-2">
              {hasChanges && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (editor.baseline) editor.seed(editor.baseline);
                    setPatchResult(null);
                    setPatchErrorCode(null);
                  }}
                >
                  <span className="sm:hidden">{s.server.config.discardDraftShort}</span>
                  <span className="hidden sm:inline">{s.server.config.discardDraft}</span>
                </Button>
              )}
              <Button size="sm" onClick={save} disabled={!hasChanges || patchMutation.isPending}>
                {patchMutation.isPending ? s.server.config.saving : s.server.config.save}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <ConfigSavePreview
        open={savePreviewOpen}
        baseline={editor.baseline.sections}
        draft={editor.edited}
        catalog={catalogQuery.data}
        reloadPolicy={reloadPolicy}
        pending={patchMutation.isPending}
        onClose={() => setSavePreviewOpen(false)}
        onConfirm={applyPreviewedChanges}
      />
    </ServerShell>
  );
}

function countPatchChanges(value: unknown): number {
  if (Array.isArray(value)) return 1;
  if (typeof value !== "object" || value === null) return 1;
  return Object.values(value).reduce((total, item) => total + countPatchChanges(item), 0);
}
