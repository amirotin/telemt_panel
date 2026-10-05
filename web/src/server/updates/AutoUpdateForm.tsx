import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useStrings } from "../../i18n";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { Sheet } from "../../ui/Sheet";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { pushToast } from "../../ui/Toast";
import { apiErrorCode, apiErrorMessage } from "../../people/apiError";
import {
  getAutoUpdateOptions,
  getAutoUpdateQueryKey,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import { getAutoUpdate, putAutoUpdate } from "../../lib/api/generated/sdk.gen";
import {
  serializeAutoUpdateForm,
  toAutoUpdateFormState,
  type AutoUpdateFormState,
} from "./autoUpdate.helpers";
import { acknowledgeSubmitted, discardToRemote, type SubmittedDraft } from "../../lib/draftSession";
import { useDraftSession } from "../../lib/draftSessionReact";
import { DraftSessionActions } from "../../lib/draftSessionActions";
import type { AutoUpdateSettings, PutAutoUpdateError } from "../../lib/api/generated/types.gen";

const MODES = ["off", "check", "apply"] as const;
const INTERVALS = [1, 6, 12, 24];
type Mode = (typeof MODES)[number];
const equalForm = (a: AutoUpdateFormState, b: AutoUpdateFormState) => a.telemt === b.telemt && a.panel === b.panel && a.intervalHours === b.intervalHours;

export function AutoUpdateForm({ canApply }: { canApply: boolean }) {
  const s = useStrings();
  const query = useQuery(getAutoUpdateOptions());
  if (query.isPending) return <Skeleton className="h-64 w-full" />;
  if (query.isError && !query.data) {
    return (
      <ErrorState
        message={errorMessage(s, apiErrorCode(query.error) ?? "internal_error")}
        onRetry={() => query.refetch()}
      />
    );
  }
  if (!query.data) return null;
  return <AutoUpdateSession initial={query.data} canApply={canApply} />;
}

function AutoUpdateSession({ initial, canApply }: { initial: AutoUpdateSettings; canApply: boolean }) {
  const s = useStrings();
  const queryClient = useQueryClient();
  const { session, update, current } = useDraftSession("auto-update", { value: toAutoUpdateFormState(initial), revision: null }, equalForm);
  const form = session.draft;
  const setForm = (next: AutoUpdateFormState) => update((state) => ({ ...state, draft: next }));
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const requestSequence = useRef(0);
  const activeSave = useRef<number | null>(null);
  useEffect(() => () => { activeSave.current = null; }, []);
  const saveMutation = useMutation({
    mutationFn: (submitted: SubmittedDraft<AutoUpdateFormState>) => putAutoUpdate({ body: serializeAutoUpdateForm(submitted.value), throwOnError: true }),
    onSuccess: async (_next, submitted) => {
      if (activeSave.current !== submitted.requestId || current.current.sessionKey !== submitted.sessionKey) return;
      update((state) => acknowledgeSubmitted(state, submitted, { value: submitted.value, revision: null }, equalForm));
      const remoteBeforeRefresh = current.current.remote;
      const cacheRevision = queryClient.getQueryState(getAutoUpdateQueryKey())?.dataUpdateCount;
      await queryClient.cancelQueries({ queryKey: getAutoUpdateQueryKey() }, { revert: false });
      if (activeSave.current !== submitted.requestId || current.current.sessionKey !== submitted.sessionKey) return;
      const { data: fresh } = await getAutoUpdate({ throwOnError: true });
      if (activeSave.current !== submitted.requestId || current.current.sessionKey !== submitted.sessionKey) return;
      const latest = queryClient.getQueryData<AutoUpdateSettings>(getAutoUpdateQueryKey());
      if (queryClient.getQueryState(getAutoUpdateQueryKey())?.dataUpdateCount !== cacheRevision && (!latest || !equalForm(toAutoUpdateFormState(latest), toAutoUpdateFormState(fresh)))) {
        activeSave.current = null;
        return;
      }
      update((state) => {
        const confirmed = acknowledgeSubmitted(state, submitted, { value: toAutoUpdateFormState(fresh), revision: null }, equalForm);
        // A post-save GET supersedes the snapshot retained before it started.
        // A different remote arriving during that GET remains a conflict.
        return state.remote === remoteBeforeRefresh && confirmed.remote ? { ...confirmed, remote: null } : confirmed;
      });
      queryClient.setQueryData(getAutoUpdateQueryKey(), fresh);
      activeSave.current = null;
      const confirmed = current.current;
      if (equalForm(confirmed.draft, confirmed.baseline.value) && !confirmed.remote) pushToast(s.server.updates.autoUpdate.saved, "ok");
    },
    onError: (err: PutAutoUpdateError, submitted) => {
      if (activeSave.current !== submitted.requestId) return;
      activeSave.current = null;
      pushToast(apiErrorMessage(err, s), "error");
    },
  });

  const dirty = !equalForm(form, session.baseline.value);
  const modes = [form.telemt, form.panel];
  const summary = modes.every((mode) => mode === "off")
    ? s.server.updates.autoUpdate.states.off
    : modes.some((mode) => mode === "apply")
      ? s.server.updates.autoUpdate.states.apply
      : s.server.updates.autoUpdate.states.check;
  const intro = modes.every((mode) => mode === "off")
    ? s.server.updates.autoUpdate.introOff
    : modes.some((mode) => mode === "apply")
      ? s.server.updates.autoUpdate.introApply
      : s.server.updates.autoUpdate.introCheck;
  const intervalOptions = INTERVALS.includes(form.intervalHours)
    ? INTERVALS
    : [...INTERVALS, form.intervalHours].sort((a, b) => a - b);

  return (
    <>
      <Card className="overflow-hidden !p-0">
        <div className="flex min-h-[58px] items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <p className="text-micro uppercase tracking-wide text-text-faint">
              {s.server.updates.autoUpdate.eyebrow}
            </p>
            <CardTitle className="mt-0.5">{s.server.updates.autoUpdate.title}</CardTitle>
          </div>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-micro font-semibold text-text-muted">
            {summary}
          </span>
        </div>

        <div className="px-4 py-3">
          {session.remote && <DraftSessionActions conflict onDiscard={() => update(discardToRemote)} disabled={saveMutation.isPending} />}
          <p className="mb-3 text-micro leading-relaxed text-text-muted">{intro}</p>
          <ModeRow
            label={s.server.updates.targetNames.telemt}
            value={form.telemt}
            canApply={canApply}
            onChange={(telemt) => setForm({ ...form, telemt })}
          />
          <ModeRow
            label={s.server.updates.targetNames.panel}
            value={form.panel}
            canApply={canApply}
            onChange={(panel) => setForm({ ...form, panel })}
          />

          <label className="flex min-h-[62px] items-center gap-3 border-b border-border py-3">
            <span className="min-w-0 flex-1">
              <strong className="block text-meta text-text">{s.server.updates.autoUpdate.intervalLabel}</strong>
              <small className="mt-0.5 block text-micro text-text-faint">{s.server.updates.autoUpdate.intervalDetail}</small>
            </span>
            <select
              className="tap-target min-w-[7rem] rounded-xl border border-border bg-surface-2 px-3 text-meta text-text outline-none focus:border-accent"
              value={form.intervalHours}
              onChange={(event) => setForm({ ...form, intervalHours: Number(event.target.value) })}
            >
              {intervalOptions.map((hours) => (
                <option key={hours} value={hours}>
                  {s.server.updates.autoUpdate.hours.replace("{count}", String(hours))}
                </option>
              ))}
            </select>
          </label>

          {!canApply && (
            <div className="mt-3 rounded-xl border border-warn/25 bg-warn/[0.06] p-3">
              <p className="text-meta font-semibold text-text">{s.server.updates.autoUpdate.unavailableTitle}</p>
              <p className="mt-1 text-micro leading-relaxed text-text-muted">{s.server.updates.autoUpdate.unavailableDetail}</p>
              <button type="button" className="tap-target -ml-2 mt-1 px-2 text-micro font-semibold text-accent" onClick={() => setCapabilityOpen(true)}>
                {s.server.updates.howToEnable}
              </button>
            </div>
          )}

          <Button
            variant={dirty ? "primary" : "secondary"}
            onClick={() => {
              if (activeSave.current !== null) return;
              const submitted = { sessionKey: session.sessionKey, value: { ...form }, revision: null, requestId: ++requestSequence.current };
              activeSave.current = submitted.requestId;
              saveMutation.mutate(submitted);
            }}
            disabled={!dirty || saveMutation.isPending}
            className="mt-3"
          >
            {dirty || session.remote ? s.server.updates.autoUpdate.save : s.server.updates.autoUpdate.savedShort}
          </Button>
        </div>
      </Card>

      <Sheet
        open={capabilityOpen}
        onClose={() => setCapabilityOpen(false)}
        eyebrow={s.server.updates.hostCapabilities}
        title={s.server.updates.installUnavailableTitle}
      >
        <div className="flex flex-col gap-3">
          <p className="text-meta leading-relaxed text-text-muted">{s.server.updates.installUnavailableDetail}</p>
          <div className="rounded-xl border border-warn/25 bg-warn/[0.06] p-3">
            <p className="text-meta font-semibold text-warn">{s.server.updates.installerPendingTitle}</p>
            <p className="mt-1 text-micro leading-relaxed text-text-muted">{s.server.updates.installerPendingDetail}</p>
          </div>
          <Button className="self-start" onClick={() => setCapabilityOpen(false)}>{s.server.updates.dismiss}</Button>
        </div>
      </Sheet>
    </>
  );
}

function ModeRow({
  label,
  value,
  canApply,
  onChange,
}: {
  label: string;
  value: Mode;
  canApply: boolean;
  onChange: (next: Mode) => void;
}) {
  const s = useStrings();
  return (
    <div className="border-b border-border py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <strong className="text-meta text-text">{label}</strong>
        <span className="text-micro text-text-faint">{s.server.updates.autoUpdate.modes[value]}</span>
      </div>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-sunken p-1" role="radiogroup" aria-label={label}>
        {MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={value === mode}
            disabled={mode === "apply" && !canApply}
            className={`min-h-10 rounded-lg px-1 text-[10px] font-semibold transition-colors ${value === mode ? "border border-border-strong bg-surface-2 text-text" : "border border-transparent text-text-faint hover:text-text-muted"} disabled:cursor-not-allowed disabled:opacity-35`}
            onClick={() => onChange(mode)}
          >
            {s.server.updates.autoUpdate.modes[mode]}
          </button>
        ))}
      </div>
    </div>
  );
}
