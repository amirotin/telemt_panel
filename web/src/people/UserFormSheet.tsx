import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sheet } from "../ui/Sheet";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Stepper } from "../ui/Stepper";
import { IconButton } from "../ui/IconButton";
import { pushToast } from "../ui/Toast";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { copyText } from "../lib/copyText";
import {
  createUserMutation,
  patchUserMutation,
} from "../lib/api/generated/@tanstack/react-query.gen";
import {
  buildUserCreateBody,
  buildUserPatch,
  type LimitFieldState,
} from "./buildUserPatch";
import {
  bytesToQuotaDisplay,
  isValidSecret,
  isValidUsername,
  quotaUnitToBytes,
  type QuotaUnit,
} from "./users.helpers";
import { datetimeLocalValueToISO, isoToDatetimeLocalValue, presetToExpiration } from "./expiry";
import { generateSecret } from "./secret";
import { apiErrorMessage } from "./apiError";
import { refreshUsersAfterMutation } from "./refreshUsersAfterMutation";
import { useRefreshTopic } from "../realtime";
import type { UsersTopicUser } from "../realtime/topics";

export interface UserFormSheetProps {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  /** Required when mode === "edit". */
  user?: UsersTopicUser | null;
  onSaved?: (username: string) => void;
}

// FieldMode is the three "не менять / снять / установить" states a limit
// field's segmented control cycles through. Create mode never shows "keep"
// (there is nothing to keep before the user exists) — it starts every field
// at "clear" (omitted -> unlimited) and only offers clear/set.
type FieldMode = "keep" | "clear" | "set";

interface FieldState<T> {
  mode: FieldMode;
  /** Retained across mode switches so toggling back to "set" doesn't lose what was typed. */
  value: T;
}

function field<T>(value: T, mode: FieldMode = "keep"): FieldState<T> {
  return { mode, value };
}

interface FormState {
  username: string;
  secret: string;
  secretVisible: boolean;
  enabled: boolean;
  userAdTag: FieldState<string>;
  maxTcpConns: FieldState<number>;
  maxUniqueIps: FieldState<number>;
  quotaAmount: FieldState<number>;
  quotaUnit: QuotaUnit;
  expiration: FieldState<string>;
  rateLimitUpBps: FieldState<number>;
  rateLimitDownBps: FieldState<number>;
}

function initialCreateState(): FormState {
  return {
    username: "",
    secret: generateSecret(),
    secretVisible: false,
    enabled: true,
    userAdTag: field("", "clear"),
    maxTcpConns: field(4, "clear"),
    maxUniqueIps: field(2, "clear"),
    quotaAmount: field(10, "clear"),
    quotaUnit: "GB",
    expiration: field("", "clear"),
    rateLimitUpBps: field(0, "clear"),
    rateLimitDownBps: field(0, "clear"),
  };
}

function initialEditState(user: UsersTopicUser): FormState {
  const quota = bytesToQuotaDisplay(user.data_quota_bytes ?? 0);
  return {
    username: user.username,
    secret: "",
    secretVisible: false,
    enabled: user.enabled,
    userAdTag: field(user.user_ad_tag ?? ""),
    maxTcpConns: field(user.max_tcp_conns ?? 4),
    maxUniqueIps: field(user.max_unique_ips ?? 2),
    quotaAmount: field(quota.value),
    quotaUnit: quota.unit,
    expiration: field(user.expiration_rfc3339 ?? ""),
    rateLimitUpBps: field(user.rate_limit_up_bps ?? 0),
    rateLimitDownBps: field(user.rate_limit_down_bps ?? 0),
  };
}

// UserFormSheet — create/edit form (06-ui.md §Люди): name, generated secret
// (create only — edit rotates via a separate action, per 07-telemt-sdk.md),
// quota, expiry, connection/IP limits, rate limits, ad tag. Every optional
// limit is a three-state segmented control in edit mode (не менять / снять
// / установить); create mode collapses that to two states (omit / set)
// since there is no prior value to "keep" — buildUserPatch/buildUserCreateBody
// (buildUserPatch.ts) are the pure serializers this component's Submit
// handler feeds into.
export function UserFormSheet({ open, onClose, mode, user, onSaved }: UserFormSheetProps) {
  const [state, setState] = useState<FormState>(() =>
    mode === "edit" && user ? initialEditState(user) : initialCreateState(),
  );
  const [usernameTouched, setUsernameTouched] = useState(false);

  // Reset local state whenever the sheet is (re)opened for a (possibly
  // different) user/mode — Sheet stays mounted across opens in the parent,
  // so this can't rely on remount. Adjusting state during render (React's
  // own recommended pattern for "reset state when a prop changes",
  // https://react.dev/learn/you-might-not-need-an-effect) rather than in a
  // useEffect: an effect here would set state synchronously right after
  // the first render with stale (pre-open) values, causing an extra
  // cascading render — this bails out during the same render instead.
  const openKey = open ? `${mode}:${mode === "edit" ? (user?.username ?? "") : "create"}` : null;
  const [lastOpenKey, setLastOpenKey] = useState<string | null>(null);
  if (openKey !== null && openKey !== lastOpenKey) {
    setLastOpenKey(openKey);
    setState(mode === "edit" && user ? initialEditState(user) : initialCreateState());
    setUsernameTouched(false);
  }

  const refreshTopic = useRefreshTopic();

  const createMutation = useMutation({
    ...createUserMutation(),
    onSuccess: (data) => {
      pushToast(ru.people.toast.created, "ok");
      onSaved?.(data.user.username);
      onClose();
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  const patchMutation = useMutation({
    ...patchUserMutation(),
    onSuccess: (data) => {
      pushToast(ru.people.toast.updated, "ok");
      onSaved?.(data.username);
      onClose();
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  const pending = createMutation.isPending || patchMutation.isPending;
  const usernameValid = isValidUsername(state.username);
  const canSubmit = mode === "edit" || (usernameValid && isValidSecret(state.secret));

  function toLimit<T>(f: FieldState<T>): LimitFieldState<T> {
    if (f.mode === "keep") return { mode: "keep" };
    if (f.mode === "clear") return { mode: "clear" };
    return { mode: "set", value: f.value };
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || pending) return;

    const quotaBytesField: FieldState<number> = {
      mode: state.quotaAmount.mode,
      value: quotaUnitToBytes(state.quotaAmount.value, state.quotaUnit),
    };

    if (mode === "create") {
      createMutation.mutate({
        body: buildUserCreateBody({
          username: state.username,
          secret: state.secret,
          enabled: state.enabled,
          userAdTag: state.userAdTag.mode === "set" ? state.userAdTag.value : undefined,
          maxTcpConns: state.maxTcpConns.mode === "set" ? state.maxTcpConns.value : undefined,
          maxUniqueIps: state.maxUniqueIps.mode === "set" ? state.maxUniqueIps.value : undefined,
          dataQuotaBytes: quotaBytesField.mode === "set" ? quotaBytesField.value : undefined,
          expirationRfc3339: state.expiration.mode === "set" ? state.expiration.value : undefined,
          rateLimitUpBps: state.rateLimitUpBps.mode === "set" ? state.rateLimitUpBps.value : undefined,
          rateLimitDownBps:
            state.rateLimitDownBps.mode === "set" ? state.rateLimitDownBps.value : undefined,
        }),
      });
      return;
    }

    patchMutation.mutate({
      path: { username: state.username },
      body: buildUserPatch({
        userAdTag: toLimit(state.userAdTag),
        maxTcpConns: toLimit(state.maxTcpConns),
        maxUniqueIps: toLimit(state.maxUniqueIps),
        dataQuotaBytes: toLimit(quotaBytesField),
        expirationRfc3339: toLimit(state.expiration),
        rateLimitUpBps: toLimit(state.rateLimitUpBps),
        rateLimitDownBps: toLimit(state.rateLimitDownBps),
      }),
    });
  }

  return (
    <Sheet open={open} onClose={onClose} title={mode === "create" ? ru.people.form.createTitle : ru.people.form.editTitle}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
        <label className="flex flex-col gap-1 text-sm text-text-muted">
          {ru.people.form.username}
          <Input
            value={state.username}
            disabled={mode === "edit"}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setUsernameTouched(true);
              setState((s) => ({ ...s, username: e.target.value }));
            }}
          />
          <span className="text-xs text-text-faint">
            {usernameTouched && !usernameValid && state.username.length > 0
              ? ru.people.form.usernameInvalid
              : ru.people.form.usernameHint}
          </span>
        </label>

        {mode === "create" && (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-text-muted">{ru.people.form.secret}</span>
            <div className="flex items-center gap-2">
              {/* type="password"/"text" toggling (not a manually-rendered
                  mask) so the field stays directly editable/pastable — an
                  admin can paste a custom hex secret instead of the
                  generated default. */}
              <Input
                type={state.secretVisible ? "text" : "password"}
                monospace
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={state.secret}
                onChange={(e) => setState((s) => ({ ...s, secret: e.target.value.trim() }))}
                className="flex-1"
              />
              <IconButton
                type="button"
                aria-label={state.secretVisible ? ru.people.form.hide : ru.people.form.show}
                onClick={() => setState((s) => ({ ...s, secretVisible: !s.secretVisible }))}
              >
                {state.secretVisible ? "🙈" : "👁"}
              </IconButton>
              <IconButton
                type="button"
                aria-label={ru.common.copy}
                // Always copies the current secret directly (not via
                // CopyField, which would need the raw value passed into a
                // visible span regardless of the show/hide toggle above).
                onClick={async () => {
                  const result = await copyText(state.secret);
                  if (result === "failed") pushToast(ru.common.copyManually, "error");
                  else pushToast(ru.common.copied, "ok");
                }}
              >
                ⧉
              </IconButton>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setState((s) => ({ ...s, secret: generateSecret() }))}
              >
                {ru.people.form.secretRegenerate}
              </Button>
            </div>
            {state.secret.length > 0 && !isValidSecret(state.secret) && (
              <span className="text-xs text-error">{ru.people.form.secretInvalid}</span>
            )}
          </div>
        )}

        <QuotaField
          formMode={mode}
          amount={state.quotaAmount}
          unit={state.quotaUnit}
          onChangeAmount={(f) => setState((s) => ({ ...s, quotaAmount: f }))}
          onChangeUnit={(unit) => setState((s) => ({ ...s, quotaUnit: unit }))}
        />

        <ExpiryField
          formMode={mode}
          field={state.expiration}
          onChange={(f) => setState((s) => ({ ...s, expiration: f }))}
        />

        <NumericLimitField
          label={ru.people.form.maxConnections}
          formMode={mode}
          field={state.maxTcpConns}
          min={1}
          max={1000}
          onChange={(f) => setState((s) => ({ ...s, maxTcpConns: f }))}
        />

        <NumericLimitField
          label={ru.people.form.maxIps}
          formMode={mode}
          field={state.maxUniqueIps}
          min={1}
          max={1000}
          onChange={(f) => setState((s) => ({ ...s, maxUniqueIps: f }))}
        />

        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-text">
            {ru.people.form.advanced}
          </summary>
          <div className="flex flex-col gap-5 border-t border-border px-3 py-3">
            <TextLimitField
              label={ru.people.adTag}
              formMode={mode}
              field={state.userAdTag}
              monospace
              onChange={(f) => setState((s) => ({ ...s, userAdTag: f }))}
            />
            <NumericLimitField
              label={ru.people.form.rateUpLabel}
              formMode={mode}
              field={state.rateLimitUpBps}
              min={0}
              max={10_000_000_000}
              step={1000}
              onChange={(f) => setState((s) => ({ ...s, rateLimitUpBps: f }))}
            />
            <NumericLimitField
              label={ru.people.form.rateDownLabel}
              formMode={mode}
              field={state.rateLimitDownBps}
              min={0}
              max={10_000_000_000}
              step={1000}
              onChange={(f) => setState((s) => ({ ...s, rateLimitDownBps: f }))}
            />
          </div>
        </details>

        <Button type="submit" disabled={!canSubmit || pending}>
          {pending
            ? ru.people.form.submitting
            : mode === "create"
              ? ru.people.form.submitCreate
              : ru.people.form.submitEdit}
        </Button>
      </form>
    </Sheet>
  );
}

function modeLabel(m: FieldMode): string {
  return m === "keep"
    ? ru.people.form.fieldModeKeep
    : m === "clear"
      ? ru.people.form.fieldModeClear
      : ru.people.form.fieldModeSet;
}

// FieldModeControl is the explicit three/two-way switch every optional
// limit field renders (06-ui.md: "не менять / снять / установить"
// reflected by a UI-переключатель, not a magic 0). Edit mode shows all
// three; create mode shows only clear/set — see FieldMode's doc comment.
function FieldModeControl({
  formMode,
  mode,
  label,
  onChange,
}: {
  formMode: "create" | "edit";
  mode: FieldMode;
  label: string;
  onChange: (m: FieldMode) => void;
}) {
  const options: FieldMode[] = formMode === "edit" ? ["keep", "clear", "set"] : ["clear", "set"];
  return (
    <div className="flex gap-1" role="group" aria-label={label}>
      {options.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "tap-target flex-1 rounded-lg border text-xs font-medium transition-colors",
            mode === m
              ? "border-accent bg-accent/10 text-accent"
              : "border-border text-text-muted hover:bg-surface-2",
          )}
        >
          {modeLabel(m)}
        </button>
      ))}
    </div>
  );
}

function NumericLimitField({
  label,
  formMode,
  field: f,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  formMode: "create" | "edit";
  field: FieldState<number>;
  min?: number;
  max?: number;
  step?: number;
  onChange: (f: FieldState<number>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-text-muted">{label}</span>
      <FieldModeControl formMode={formMode} mode={f.mode} label={label} onChange={(mode) => onChange({ ...f, mode })} />
      {f.mode === "set" && (
        <Stepper
          value={f.value}
          onChange={(value) => onChange({ ...f, value })}
          min={min}
          max={max}
          step={step}
          label={label}
        />
      )}
    </div>
  );
}

function TextLimitField({
  label,
  formMode,
  field: f,
  monospace,
  onChange,
}: {
  label: string;
  formMode: "create" | "edit";
  field: FieldState<string>;
  monospace?: boolean;
  onChange: (f: FieldState<string>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-text-muted">{label}</span>
      <FieldModeControl formMode={formMode} mode={f.mode} label={label} onChange={(mode) => onChange({ ...f, mode })} />
      {f.mode === "set" && (
        <Input
          value={f.value}
          monospace={monospace}
          autoCapitalize="off"
          onChange={(e) => onChange({ ...f, value: e.target.value })}
        />
      )}
    </div>
  );
}

function QuotaField({
  formMode,
  amount,
  unit,
  onChangeAmount,
  onChangeUnit,
}: {
  formMode: "create" | "edit";
  amount: FieldState<number>;
  unit: QuotaUnit;
  onChangeAmount: (f: FieldState<number>) => void;
  onChangeUnit: (u: QuotaUnit) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-text-muted">{ru.people.form.quota}</span>
      <FieldModeControl
        formMode={formMode}
        mode={amount.mode}
        label={ru.people.form.quota}
        onChange={(mode) => onChangeAmount({ ...amount, mode })}
      />
      {amount.mode === "set" && (
        <div className="flex gap-2">
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            value={amount.value}
            onChange={(e) => onChangeAmount({ ...amount, value: Number(e.target.value) })}
            className="flex-1"
          />
          <Select value={unit} onChange={(e) => onChangeUnit(e.target.value as QuotaUnit)} className="w-24">
            <option value="MB">{ru.people.form.quotaUnits.MB}</option>
            <option value="GB">{ru.people.form.quotaUnits.GB}</option>
          </Select>
        </div>
      )}
      {amount.mode !== "set" && <span className="text-xs text-text-faint">{ru.people.form.quotaUnlimited}</span>}
    </div>
  );
}

function ExpiryField({
  formMode,
  field: f,
  onChange,
}: {
  formMode: "create" | "edit";
  field: FieldState<string>;
  onChange: (f: FieldState<string>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-text-muted">{ru.people.form.expiry}</span>
      <FieldModeControl
        formMode={formMode}
        mode={f.mode}
        label={ru.people.form.expiry}
        onChange={(mode) => onChange({ ...f, mode })}
      />
      {f.mode === "set" && (
        <div className="flex flex-col gap-2">
          <Input
            type="datetime-local"
            value={isoToDatetimeLocalValue(f.value)}
            onChange={(e) => {
              const iso = datetimeLocalValueToISO(e.target.value);
              if (iso) onChange({ ...f, value: iso });
            }}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={() => onChange({ ...f, value: presetToExpiration("7d", new Date())! })}
            >
              {ru.people.form.expiryPreset7d}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={() => onChange({ ...f, value: presetToExpiration("30d", new Date())! })}
            >
              {ru.people.form.expiryPreset30d}
            </Button>
          </div>
        </div>
      )}
      {f.mode !== "set" && <span className="text-xs text-text-faint">{ru.people.form.expiryPresetNone}</span>}
    </div>
  );
}
