import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ru, errorMessage } from "../../i18n/ru";
import { Select } from "../../ui/Select";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { pushToast } from "../../ui/Toast";
import { apiErrorMessage } from "../../people/apiError";
import {
  getAutoUpdateOptions,
  getAutoUpdateQueryKey,
  putAutoUpdateMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import { serializeAutoUpdateForm, toAutoUpdateFormState, type AutoUpdateFormState } from "./autoUpdate.helpers";

const MODES = ["off", "check", "apply"] as const;

// AutoUpdateForm — GET/PUT /api/updates/auto (03-update-engine.md
// §Auto-update): per-target mode (off/check/apply) and a shared interval,
// persisted to the store, never rewriting the panel's own config file.
export function AutoUpdateForm() {
  const queryClient = useQueryClient();
  const query = useQuery(getAutoUpdateOptions());
  const [form, setForm] = useState<AutoUpdateFormState | null>(null);

  // Seed once on first load — render-time adjustment, not a useEffect (see
  // server/config/useConfigEditor.ts's own doc comment for why).
  if (query.data && !form) {
    setForm(toAutoUpdateFormState(query.data));
  }

  const saveMutation = useMutation({
    ...putAutoUpdateMutation(),
    onSuccess: () => {
      pushToast(ru.server.updates.autoUpdate.saved, "ok");
      queryClient.invalidateQueries({ queryKey: getAutoUpdateQueryKey() });
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  if (query.isPending) return <Skeleton className="h-32 w-full" />;
  if (query.isError) {
    return <ErrorState message={errorMessage("internal_error")} onRetry={() => query.refetch()} />;
  }
  if (!form) return null;

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold text-text">{ru.server.updates.autoUpdate.title}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">{ru.server.updates.targetNames.telemt}</span>
          <Select value={form.telemt} onChange={(e) => setForm({ ...form, telemt: e.target.value as AutoUpdateFormState["telemt"] })} className="w-44">
            {MODES.map((m) => (
              <option key={m} value={m}>
                {ru.server.updates.autoUpdate.modes[m]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">{ru.server.updates.targetNames.panel}</span>
          <Select value={form.panel} onChange={(e) => setForm({ ...form, panel: e.target.value as AutoUpdateFormState["panel"] })} className="w-44">
            {MODES.map((m) => (
              <option key={m} value={m}>
                {ru.server.updates.autoUpdate.modes[m]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">{ru.server.updates.autoUpdate.intervalLabel}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            className="w-24"
            value={form.intervalHours}
            onChange={(e) => setForm({ ...form, intervalHours: Number(e.target.value) || 1 })}
          />
        </label>
        <Button
          onClick={() => saveMutation.mutate({ body: serializeAutoUpdateForm(form) })}
          disabled={saveMutation.isPending}
        >
          {ru.server.updates.autoUpdate.save}
        </Button>
      </div>
    </section>
  );
}
