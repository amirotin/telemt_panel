import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sheet } from "../ui/Sheet";
import { Button } from "../ui/Button";
import { CopyField } from "../ui/CopyField";
import { Toggle } from "../ui/Toggle";
import { pushToast } from "../ui/Toast";
import { useStrings } from "../i18n";
import {
  createUserMutation,
  patchUserMutation,
} from "../lib/api/generated/@tanstack/react-query.gen";
import {
  buildUserCreateBody,
  buildUserPatch,
  diffLimitField,
  type LimitFieldState,
} from "./buildUserPatch";
import {
  bytesToQuotaDisplay,
  isValidSecret,
  isValidUsername,
  quotaUnitToBytes,
  type QuotaUnit,
} from "./users.helpers";
import { presetToExpiration } from "./expiry";
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
  onConfigureWeb?: (username: string) => void;
}

// The form renders set values directly and treats an empty optional input as
// clear. "keep" is retained as an internal PATCH serialization state only.
type FieldMode = "clear" | "set";

interface FieldState<T> {
  mode: FieldMode;
  /** Retained across mode switches so toggling back to "set" doesn't lose what was typed. */
  value: T;
}

function field<T>(value: T, mode: FieldMode): FieldState<T> {
  return { mode, value };
}

interface FormState {
  username: string;
  secret: string;
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
    enabled: user.enabled,
    userAdTag: field(user.user_ad_tag ?? "", user.user_ad_tag ? "set" : "clear"),
    maxTcpConns: field(user.max_tcp_conns || 4, user.max_tcp_conns ? "set" : "clear"),
    maxUniqueIps: field(user.max_unique_ips || 2, user.max_unique_ips ? "set" : "clear"),
    quotaAmount: field(quota.value, user.data_quota_bytes ? "set" : "clear"),
    quotaUnit: user.data_quota_bytes ? quota.unit : "GB",
    expiration: field(user.expiration_rfc3339 ?? "", user.expiration_rfc3339 ? "set" : "clear"),
    rateLimitUpBps: field(user.rate_limit_up_bps ?? 0, user.rate_limit_up_bps ? "set" : "clear"),
    rateLimitDownBps: field(user.rate_limit_down_bps ?? 0, user.rate_limit_down_bps ? "set" : "clear"),
  };
}

// UserFormSheet — create/edit form (06-ui.md §Люди): name, generated secret
// (create only — edit rotates via a separate action, per 07-telemt-sdk.md),
// quota, expiry, connection/IP limits, rate limits, ad tag. Every optional
// limit uses the same direct-value controls in both modes. Empty optional
// fields mean "unlimited/not set"; the edit serializer compares the resulting
// state with the original user so untouched values remain omitted from PATCH.
export function UserFormSheet({ open, onClose, mode, user, onSaved, onConfigureWeb }: UserFormSheetProps) {
  const s = useStrings();
  const [state, setState] = useState<FormState>(() =>
    mode === "edit" && user ? initialEditState(user) : initialCreateState(),
  );
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState<"unlimited" | "personal" | "temporary" | null>(
    mode === "create" ? "unlimited" : null,
  );

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
    setCreatedSecret(null);
    setActivePreset(mode === "create" ? "unlimited" : null);
  }

  const refreshTopic = useRefreshTopic();

  const createMutation = useMutation({
    ...createUserMutation(),
    onSuccess: (data) => {
      pushToast(s.people.toast.created, "ok");
      onSaved?.(data.user.username);
      setCreatedSecret(data.secret);
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const patchMutation = useMutation({
    ...patchUserMutation(),
    onSuccess: (data) => {
      pushToast(s.people.toast.updated, "ok");
      onSaved?.(data.username);
      onClose();
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const pending = createMutation.isPending || patchMutation.isPending;
  const usernameValid = isValidUsername(state.username);
  const canSubmit = mode === "edit" || (usernameValid && isValidSecret(state.secret));

  function changedLimit<T>(f: FieldState<T>, original: T | undefined): LimitFieldState<T> {
    return diffLimitField(f.mode === "set" ? f.value : undefined, original);
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
        enabled: state.enabled !== user?.enabled ? state.enabled : undefined,
        userAdTag: changedLimit(state.userAdTag, user?.user_ad_tag || undefined),
        maxTcpConns: changedLimit(state.maxTcpConns, user?.max_tcp_conns || undefined),
        maxUniqueIps: changedLimit(state.maxUniqueIps, user?.max_unique_ips || undefined),
        dataQuotaBytes: changedLimit(
          quotaBytesField,
          user?.data_quota_bytes ? user.data_quota_bytes : undefined,
        ),
        expirationRfc3339: changedLimit(state.expiration, user?.expiration_rfc3339 || undefined),
        rateLimitUpBps: changedLimit(
          state.rateLimitUpBps,
          user?.rate_limit_up_bps ? user.rate_limit_up_bps : undefined,
        ),
        rateLimitDownBps: changedLimit(
          state.rateLimitDownBps,
          user?.rate_limit_down_bps ? user.rate_limit_down_bps : undefined,
        ),
      }),
    });
  }

  function applyCreatePreset(preset: "unlimited" | "personal" | "temporary") {
    setActivePreset(preset);
    if (preset === "unlimited") {
      setState((prev) => ({
        ...prev,
        maxTcpConns: { ...prev.maxTcpConns, mode: "clear" },
        maxUniqueIps: { ...prev.maxUniqueIps, mode: "clear" },
        quotaAmount: { ...prev.quotaAmount, mode: "clear" },
        expiration: { ...prev.expiration, mode: "clear" },
      }));
      return;
    }
    const temporary = preset === "temporary";
    setState((prev) => ({
      ...prev,
      maxTcpConns: field(temporary ? 12 : 50, "set"),
      maxUniqueIps: field(temporary ? 1 : 3, "set"),
      quotaAmount: field(temporary ? 50 : 500, "set"),
      quotaUnit: "GB",
      expiration: temporary
        ? field(presetToExpiration("7d", new Date())!, "set")
        : { ...prev.expiration, mode: "clear" },
    }));
  }

  if (createdSecret) {
    return (
      <Sheet open={open} onClose={onClose} placement="form" title={s.people.newSecret.title} subtitle={state.username}>
        <div className="flex flex-col gap-4 py-2">
          <p className="rounded-xl border border-warn/30 bg-warn/10 p-3 text-sm text-warn">{s.people.newSecret.warning}</p>
          <CopyField value={createdSecret} label={s.people.form.secret} data-testid="created-user-secret" />
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="secondary" onClick={onClose}>{s.people.newSecret.close}</Button>
            {onConfigureWeb && <Button onClick={() => { onClose(); onConfigureWeb(state.username); }}>{s.people.newSecret.configureWeb}</Button>}
          </div>
        </div>
      </Sheet>
    );
  }

  const expirationDate = state.expiration.mode === "set" ? state.expiration.value.slice(0, 10) : "";
  const quotaValue = state.quotaAmount.mode === "set" ? String(state.quotaAmount.value) : "";
  const maxIpsValue = state.maxUniqueIps.mode === "set" ? String(state.maxUniqueIps.value) : "";
  const maxConnectionsValue = state.maxTcpConns.mode === "set" ? String(state.maxTcpConns.value) : "";
  const rateUpMbps = state.rateLimitUpBps.mode === "set" ? String(state.rateLimitUpBps.value / 1_000_000) : "";
  const rateDownMbps = state.rateLimitDownBps.mode === "set" ? String(state.rateLimitDownBps.value / 1_000_000) : "";
  const creating = mode === "create";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      placement="form"
      eyebrow={creating ? s.people.form.createEyebrow : s.people.form.editEyebrow}
      title={creating ? s.people.form.createTitle : s.people.form.editTitle}
      subtitle={creating ? s.people.form.createSubtitle : user?.username}
      className="people-form-dialog"
      headerClassName="people-form-head"
      bodyClassName="people-form-sheet-body"
    >
      <form onSubmit={handleSubmit} className="people-create-form" noValidate>
        <div className="people-form-body">
          <section className="people-form-section">
            <div className="people-form-section-head"><strong>{s.people.form.basics}</strong><span>{s.people.form.requiredParameters}</span></div>
            <label className="people-form-field people-form-field-wide">
              <span>{s.people.form.username} <b>*</b></span>
              <input
                data-testid="user-form-username"
                value={state.username}
                required
                disabled={!creating}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={s.people.form.usernamePlaceholder}
                onChange={(event) => {
                  setUsernameTouched(true);
                  setState((prev) => ({ ...prev, username: event.target.value }));
                }}
              />
              <small>{usernameTouched && !usernameValid && state.username.length > 0 ? s.people.form.usernameInvalid : s.people.form.usernameHint}</small>
            </label>
            <div className="people-form-toggle">
              <span><strong>{s.people.form.enabled}</strong><small>{creating ? s.people.form.enabledHint : s.people.form.enabledEditHint}</small></span>
              <Toggle checked={state.enabled} onChange={(enabled) => setState((prev) => ({ ...prev, enabled }))} aria-label={s.people.form.enabled} />
            </div>
          </section>

          <section className="people-form-section">
            <div className="people-form-section-head"><strong>{s.people.form.profile}</strong><span>{s.people.form.profileHint}</span></div>
            <div className="people-form-presets" role="group" aria-label={s.people.form.profile}>
              {(["unlimited", "personal", "temporary"] as const).map((preset) => (
                <button key={preset} type="button" className={activePreset === preset ? "is-active" : ""} onClick={() => applyCreatePreset(preset)}>
                  <strong>{preset === "unlimited" ? s.people.form.profileUnlimited : preset === "personal" ? s.people.form.profilePersonal : s.people.form.profileTemporary}</strong>
                  <span>{preset === "unlimited" ? s.people.form.profileUnlimitedHint : preset === "personal" ? s.people.form.profilePersonalHint : s.people.form.profileTemporaryHint}</span>
                </button>
              ))}
            </div>
            <div className="people-form-grid">
              <label className="people-form-field">
                <span>{s.people.form.quota}</span>
                <div className="people-form-compound">
                  <input type="number" inputMode="decimal" min={0} value={quotaValue} placeholder={s.people.form.quotaUnlimited} onChange={(event) => { const value = event.target.value; setActivePreset(null); setState((prev) => ({ ...prev, quotaAmount: value === "" ? { ...prev.quotaAmount, mode: "clear" } : field(Number(value), "set") })); }} />
                  <select value={state.quotaUnit} aria-label={s.people.form.quotaUnitLabel} onChange={(event) => { setActivePreset(null); setState((prev) => ({ ...prev, quotaUnit: event.target.value as QuotaUnit })); }}><option value="MB">{s.people.form.quotaUnits.MB}</option><option value="GB">{s.people.form.quotaUnits.GB}</option><option value="TB">{s.people.form.quotaUnits.TB}</option></select>
                </div>
              </label>
              <label className="people-form-field"><span>{s.people.form.expirationShort}</span><input type="date" value={expirationDate} onChange={(event) => { const value = event.target.value; setActivePreset(null); setState((prev) => ({ ...prev, expiration: value === "" ? { ...prev.expiration, mode: "clear" } : field(new Date(`${value}T23:59:59`).toISOString(), "set") })); }} /></label>
              <label className="people-form-field"><span>{s.people.form.maxIps}</span><input type="number" inputMode="numeric" min={1} value={maxIpsValue} placeholder={s.people.form.quotaUnlimited} onChange={(event) => { const value = event.target.value; setActivePreset(null); setState((prev) => ({ ...prev, maxUniqueIps: value === "" ? { ...prev.maxUniqueIps, mode: "clear" } : field(Number(value), "set") })); }} /></label>
              <label className="people-form-field"><span>{s.people.form.maxConnections}</span><input type="number" inputMode="numeric" min={1} value={maxConnectionsValue} placeholder={s.people.form.quotaUnlimited} onChange={(event) => { const value = event.target.value; setActivePreset(null); setState((prev) => ({ ...prev, maxTcpConns: value === "" ? { ...prev.maxTcpConns, mode: "clear" } : field(Number(value), "set") })); }} /></label>
            </div>
          </section>

          <details className="people-form-section">
            <summary className="people-form-advanced-toggle"><span><strong>{s.people.form.advancedParameters}</strong><small>{s.people.form.advancedHint}</small></span><i>⌄</i></summary>
            <div className="people-form-grid pt-4">
              <label className="people-form-field"><span>{s.people.form.rateUpShort}</span><div className="people-form-compound"><input type="number" inputMode="decimal" min={0} value={rateUpMbps} placeholder={s.people.form.quotaUnlimited} onChange={(event) => { const value = event.target.value; setState((prev) => ({ ...prev, rateLimitUpBps: value === "" ? { ...prev.rateLimitUpBps, mode: "clear" } : field(Number(value) * 1_000_000, "set") })); }} /><span>{s.people.form.mbps}</span></div></label>
              <label className="people-form-field"><span>{s.people.form.rateDownShort}</span><div className="people-form-compound"><input type="number" inputMode="decimal" min={0} value={rateDownMbps} placeholder={s.people.form.quotaUnlimited} onChange={(event) => { const value = event.target.value; setState((prev) => ({ ...prev, rateLimitDownBps: value === "" ? { ...prev.rateLimitDownBps, mode: "clear" } : field(Number(value) * 1_000_000, "set") })); }} /><span>{s.people.form.mbps}</span></div></label>
              <label className="people-form-field people-form-field-wide"><span>{s.people.adTag}</span><input value={state.userAdTag.mode === "set" ? state.userAdTag.value : ""} autoComplete="off" placeholder={s.people.form.notSet} onChange={(event) => { const value = event.target.value; setState((prev) => ({ ...prev, userAdTag: value === "" ? { ...prev.userAdTag, mode: "clear" } : field(value, "set") })); }} /></label>
            </div>
          </details>
        </div>
        <footer className="people-form-foot">
          <Button type="button" variant="secondary" onClick={onClose}>{s.common.cancel}</Button>
          <Button type="submit" data-testid="user-form-submit" disabled={!canSubmit || pending}>{pending ? s.people.form.submitting : creating ? s.people.form.submitCreateFull : s.people.form.submitEdit}</Button>
        </footer>
      </form>
    </Sheet>
  );
}
