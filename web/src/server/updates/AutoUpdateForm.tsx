import { useState } from "react";
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
  putAutoUpdateMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import {
  serializeAutoUpdateForm,
  toAutoUpdateFormState,
  type AutoUpdateFormState,
} from "./autoUpdate.helpers";

const MODES = ["off", "check", "apply"] as const;
const INTERVALS = [1, 6, 12, 24];
type Mode = (typeof MODES)[number];

export function AutoUpdateForm({ canApply }: { canApply: boolean }) {
  const s = useStrings();
  const queryClient = useQueryClient();
  const query = useQuery(getAutoUpdateOptions());
  const [form, setForm] = useState<AutoUpdateFormState | null>(null);
  const [baseline, setBaseline] = useState<AutoUpdateFormState | null>(null);
  const [capabilityOpen, setCapabilityOpen] = useState(false);

  if (query.data && !form) {
    const seeded = toAutoUpdateFormState(query.data);
    setForm(seeded);
    setBaseline(seeded);
  }

  const saveMutation = useMutation({
    ...putAutoUpdateMutation(),
    onSuccess: () => {
      if (form) setBaseline(form);
      pushToast(s.server.updates.autoUpdate.saved, "ok");
      queryClient.invalidateQueries({ queryKey: getAutoUpdateQueryKey() });
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  if (query.isPending) return <Skeleton className="h-64 w-full" />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorMessage(s, apiErrorCode(query.error) ?? "internal_error")}
        onRetry={() => query.refetch()}
      />
    );
  }
  if (!form || !baseline) return null;

  const dirty =
    form.telemt !== baseline.telemt ||
    form.panel !== baseline.panel ||
    form.intervalHours !== baseline.intervalHours;
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
            onClick={() => saveMutation.mutate({ body: serializeAutoUpdateForm(form) })}
            disabled={!dirty || saveMutation.isPending}
            className="mt-3"
          >
            {dirty ? s.server.updates.autoUpdate.save : s.server.updates.autoUpdate.savedShort}
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
