import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ru, errorMessage } from "../../i18n/ru";
import { Chip } from "../../ui/Chip";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
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
type Mode = (typeof MODES)[number];

// AutoUpdateForm — GET/PUT /api/updates/auto (03-update-engine.md
// §Auto-update): per-target mode (off/check/apply) and a shared interval,
// persisted to the store, never rewriting the panel's own config file.
//
// The prototype draws auto-update as an on/off switch; this API has three
// modes per target (уведомлять ≠ устанавливать), so the row carries the
// prototype's segmented pill strip instead of a Toggle — same language,
// one more state.
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
    return (
      <ErrorState
        message={errorMessage(apiErrorCode(query.error) ?? "internal_error")}
        onRetry={() => query.refetch()}
      />
    );
  }
  if (!form) return null;

  return (
    <Card className="flex flex-col gap-1">
      <CardTitle className="pb-1">
        {ru.server.updates.autoUpdate.title}
      </CardTitle>

      <ModeRow
        label={ru.server.updates.targetNames.telemt}
        value={form.telemt}
        onChange={(telemt) => setForm({ ...form, telemt })}
      />
      <ModeRow
        label={ru.server.updates.targetNames.panel}
        value={form.panel}
        onChange={(panel) => setForm({ ...form, panel })}
      />

      <label className="flex min-h-[52px] items-center gap-3 py-2">
        <span className="min-w-0 flex-1 text-meta text-text-muted">
          {ru.server.updates.autoUpdate.intervalLabel}
        </span>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          className="w-24 shrink-0"
          value={form.intervalHours}
          onChange={(e) =>
            setForm({ ...form, intervalHours: Number(e.target.value) || 1 })
          }
        />
      </label>

      <Button
        onClick={() =>
          saveMutation.mutate({ body: serializeAutoUpdateForm(form) })
        }
        disabled={saveMutation.isPending}
        className="mt-1 self-start"
      >
        {ru.server.updates.autoUpdate.save}
      </Button>
    </Card>
  );
}

function ModeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Mode;
  onChange: (next: Mode) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-2.5">
      <span className="text-meta text-text-muted">{label}</span>
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
        {MODES.map((mode) => (
          <Chip
            key={mode}
            active={value === mode}
            onClick={() => onChange(mode)}
          >
            {ru.server.updates.autoUpdate.modes[mode]}
          </Chip>
        ))}
      </div>
    </div>
  );
}
