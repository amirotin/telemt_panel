import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getMeQueryKey } from "../../auth/guards";
import { copyText } from "../../lib/copyText";
import {
  totpDisableMutation,
  totpEnableMutation,
  totpSetupMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { TotpSetupResponse } from "../../lib/api/generated/types.gen";
import { errorMessage, useStrings } from "../../i18n";
import { apiErrorCode } from "../../people/apiError";
import { Button } from "../../ui/Button";
import { ConfirmView } from "../../ui/ConfirmView";
import { ErrorState } from "../../ui/ErrorState";
import { Input } from "../../ui/Input";
import { QR } from "../../ui/QR";
import { Sheet } from "../../ui/Sheet";
import { pushToast } from "../../ui/Toast";
import { IconShield } from "../../ui/icons";

interface TwoFactorSettingsProps {
  enabled: boolean;
}

function downloadRecoveryCodes(codes: string[]) {
  const blob = new Blob([`${codes.join("\n")}\n`], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "telemt-panel-recovery-codes.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function TwoFactorSettings({ enabled }: TwoFactorSettingsProps) {
  const s = useStrings();
  const queryClient = useQueryClient();
  const [setupOpen, setSetupOpen] = useState(false);
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [codesSaved, setCodesSaved] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  function refreshIdentity() {
    void queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
  }

  function resetSetup() {
    setSetupOpen(false);
    setSetup(null);
    setCode("");
    setRecoveryCodes(null);
    setCodesSaved(false);
    setCloseWarning(false);
    setupMutation.reset();
    enableMutation.reset();
  }

  const setupMutation = useMutation({
    ...totpSetupMutation(),
    onSuccess: (data) => setSetup(data),
  });

  const enableMutation = useMutation({
    ...totpEnableMutation(),
    onSuccess: (data) => {
      setRecoveryCodes(data.recovery_codes);
      setCloseWarning(false);
      refreshIdentity();
      pushToast(s.server.settings.twoFactorEnabledToast, "ok");
    },
  });

  const disableMutation = useMutation({
    ...totpDisableMutation(),
    onSuccess: () => {
      setDisableOpen(false);
      refreshIdentity();
      pushToast(s.server.settings.twoFactorDisabledToast, "ok");
    },
    onError: (error) =>
      pushToast(errorMessage(s, apiErrorCode(error) ?? "network"), "error"),
  });

  function openSetup() {
    setSetupOpen(true);
    setSetup(null);
    setCode("");
    setRecoveryCodes(null);
    setCodesSaved(false);
    setCloseWarning(false);
    setupMutation.mutate({});
  }

  function closeSetup() {
    if (recoveryCodes && !codesSaved) {
      setCloseWarning(true);
      return;
    }
    resetSetup();
  }

  async function copyRecoveryCodes() {
    if (!recoveryCodes) return;
    const result = await copyText(recoveryCodes.join("\n"));
    pushToast(
      result === "failed" ? s.common.copyManually : s.server.settings.twoFactorCodesCopied,
      result === "failed" ? "error" : "ok",
    );
  }

  return (
    <>
      <section className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl bg-surface p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <span
          className={
            enabled
              ? "inline-flex h-9 w-9 items-center justify-center rounded-lg bg-ok/12 text-ok"
              : "inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent"
          }
          aria-hidden="true"
        >
          <IconShield />
        </span>
        <div className="min-w-0">
          <span className="block text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
            {s.server.settings.twoFactorEyebrow}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-2">
            <strong className="text-[12px] text-text">{s.server.settings.twoFactorTitle}</strong>
            <small
              className={
                enabled
                  ? "rounded-full bg-ok/12 px-2 py-0.5 text-[9px] font-bold text-ok"
                  : "rounded-full bg-surface-2 px-2 py-0.5 text-[9px] font-bold text-text-muted"
              }
            >
              {enabled ? s.server.settings.twoFactorEnabled : s.server.settings.twoFactorDisabled}
            </small>
          </span>
          <p className="mt-1 text-[10px] leading-snug text-text-faint">
            {enabled
              ? s.server.settings.twoFactorEnabledNote
              : s.server.settings.twoFactorDisabledNote}
          </p>
        </div>
        <Button
          variant={enabled ? "danger" : "secondary"}
          size="sm"
          className="col-span-2 sm:col-span-1"
          onClick={() => (enabled ? setDisableOpen(true) : openSetup())}
        >
          {enabled
            ? s.server.settings.twoFactorDisable
            : s.server.settings.twoFactorEnable}
        </Button>
      </section>

      <Sheet
        open={setupOpen}
        onClose={closeSetup}
        eyebrow={s.server.settings.twoFactorEyebrow}
        title={
          recoveryCodes
            ? s.server.settings.twoFactorRecoveryTitle
            : s.server.settings.twoFactorSetupTitle
        }
        subtitle={
          recoveryCodes
            ? s.server.settings.twoFactorRecoveryNote
            : s.server.settings.twoFactorSetupNote
        }
        bodyClassName="pb-safe"
      >
        {recoveryCodes ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-bg p-3 font-mono text-[13px] font-bold tracking-[0.05em] text-text sm:grid-cols-2">
              {recoveryCodes.map((recoveryCode) => (
                <code key={recoveryCode} className="rounded-md bg-surface px-2 py-2 text-center">
                  {recoveryCode}
                </code>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => void copyRecoveryCodes()}>
                {s.server.settings.twoFactorCopyCodes}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  downloadRecoveryCodes(recoveryCodes);
                  pushToast(s.server.settings.twoFactorCodesDownloaded, "ok");
                }}
              >
                {s.server.settings.twoFactorDownloadCodes}
              </Button>
            </div>
            <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl bg-accent/8 px-3 py-3 text-[12px] leading-snug text-text">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
                checked={codesSaved}
                onChange={(event) => {
                  setCodesSaved(event.target.checked);
                  setCloseWarning(false);
                }}
              />
              <span>{s.server.settings.twoFactorSavedAck}</span>
            </label>
            {closeWarning && (
              <p role="alert" className="rounded-lg bg-warning/10 px-3 py-2 text-[11px] text-warning">
                {s.server.settings.twoFactorCloseWarning}
              </p>
            )}
            <Button disabled={!codesSaved} onClick={resetSetup}>
              {s.server.settings.twoFactorDone}
            </Button>
          </div>
        ) : setupMutation.isPending ? (
          <div className="py-12 text-center text-[12px] text-text-muted">
            {s.server.settings.twoFactorLoading}
          </div>
        ) : setupMutation.isError || !setup ? (
          <ErrorState
            message={errorMessage(s, apiErrorCode(setupMutation.error) ?? "network")}
            onRetry={() => setupMutation.mutate({})}
          />
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              enableMutation.mutate({ body: { code } });
            }}
          >
            <div className="flex flex-col items-center rounded-xl bg-bg p-4">
              <span className="mb-3 text-[10px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
                {s.server.settings.twoFactorScan}
              </span>
              <QR value={setup.otpauth_url} size={188} className="max-w-full" />
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <span className="block text-[10px] font-bold text-text-muted">
                {s.server.settings.twoFactorManual}
              </span>
              <code className="mt-1.5 block break-all font-mono text-[13px] font-bold tracking-[0.08em] text-text">
                {setup.secret}
              </code>
            </div>
            {enableMutation.isError && (
              <p role="alert" className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[11px] text-error">
                {errorMessage(s, apiErrorCode(enableMutation.error) ?? "network")}
              </p>
            )}
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-text-muted">
                {s.server.settings.twoFactorCode}
              </span>
              <Input
                autoFocus
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </label>
            <Button type="submit" disabled={code.length !== 6 || enableMutation.isPending}>
              {s.server.settings.twoFactorConfirm}
            </Button>
          </form>
        )}
      </Sheet>

      <Sheet
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        eyebrow={s.server.settings.twoFactorEyebrow}
        title={s.server.settings.twoFactorDisableTitle}
        subtitle={s.server.settings.twoFactorDisableNote}
      >
        <ConfirmView
          description={s.server.settings.twoFactorDisableNote}
          confirmLabel={s.server.settings.twoFactorDisable}
          danger
          pending={disableMutation.isPending}
          onCancel={() => setDisableOpen(false)}
          onConfirm={() => disableMutation.mutate({})}
        />
      </Sheet>
    </>
  );
}
