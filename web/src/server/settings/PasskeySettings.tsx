import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getMeQueryKey } from "../../auth/guards";
import {
  creationOptionsFromJSON,
  passkeysSupported,
  registrationCredentialToJSON,
} from "../../auth/webauthn";
import {
  webauthnRegisterBegin,
  webauthnRegisterFinish,
} from "../../lib/api/generated/sdk.gen";
import { webauthnDeleteCredentialMutation } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { PasskeyInfo } from "../../lib/api/generated/types.gen";
import { useStrings } from "../../i18n";
import { apiErrorMessage } from "../../people/apiError";
import { Button } from "../../ui/Button";
import { ConfirmView } from "../../ui/ConfirmView";
import { Input } from "../../ui/Input";
import { Sheet } from "../../ui/Sheet";
import { pushToast } from "../../ui/Toast";
import { IconShield } from "../../ui/icons";

interface PasskeySettingsProps {
  passkeys: PasskeyInfo[];
}

function formatPasskeyDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function PasskeySettings({ passkeys }: PasskeySettingsProps) {
  const s = useStrings();
  const queryClient = useQueryClient();
  const [setupOpen, setSetupOpen] = useState(false);
  const [name, setName] = useState("");
  const [remove, setRemove] = useState<PasskeyInfo | null>(null);
  const supported = passkeysSupported();
  const registerMutation = useMutation({
    mutationFn: async (credentialName: string) => {
      const { data: begin } = await webauthnRegisterBegin({
        body: { name: credentialName },
        throwOnError: true,
      });
      const credential = await navigator.credentials.create({
        publicKey: creationOptionsFromJSON(begin.public_key),
      });
      if (!(credential instanceof PublicKeyCredential)) throw new Error("passkey_cancelled");
      const { data } = await webauthnRegisterFinish({
        body: {
          flow_id: begin.flow_id,
          credential: registrationCredentialToJSON(credential),
        },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
      setSetupOpen(false);
      setName("");
      pushToast(s.server.settings.passkeyAddedToast, "ok");
    },
  });

  const deleteMutation = useMutation({
    ...webauthnDeleteCredentialMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
      setRemove(null);
      pushToast(s.server.settings.passkeyRemovedToast, "ok");
    },
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });

  return (
    <>
      <section className="overflow-hidden rounded-xl bg-surface">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
          <span
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent"
            aria-hidden="true"
          >
            <IconShield />
          </span>
          <div className="min-w-0">
            <span className="block text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
              {s.server.settings.passkeyEyebrow}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-2">
              <strong className="text-[12px] text-text">{s.server.settings.passkeyTitle}</strong>
              <small className="rounded-full bg-surface-2 px-2 py-0.5 text-[9px] font-bold text-text-muted">
                {passkeys.length}
              </small>
            </span>
            <p className="mt-1 text-[10px] leading-snug text-text-faint">
              {supported ? s.server.settings.passkeyNote : s.server.settings.passkeyUnsupportedNote}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="col-span-2 sm:col-span-1"
            disabled={!supported}
            onClick={() => {
              setName("");
              registerMutation.reset();
              setSetupOpen(true);
            }}
          >
            {s.server.settings.passkeyAdd}
          </Button>
        </div>

        {passkeys.length > 0 && (
          <div className="divide-y divide-border-subtle border-t border-border-subtle">
            {passkeys.map((passkey) => (
              <div key={passkey.id} className="flex min-h-14 items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-[12px] text-text">{passkey.name}</strong>
                  <small className="mt-0.5 block text-[10px] text-text-faint">
                    {passkey.last_used
                      ? s.server.settings.passkeyLastUsed.replace(
                          "{date}",
                          formatPasskeyDate(passkey.last_used),
                        )
                      : s.server.settings.passkeyNeverUsed}
                  </small>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemove(passkey)}
                >
                  {s.server.settings.passkeyRemove}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <Sheet
        open={setupOpen}
        onClose={() => {
          if (registerMutation.isPending) return;
          setSetupOpen(false);
          setName("");
          registerMutation.reset();
        }}
        eyebrow={s.server.settings.passkeyEyebrow}
        title={s.server.settings.passkeySetupTitle}
        subtitle={s.server.settings.passkeyDomainWarning.replace("{host}", window.location.hostname)}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            registerMutation.mutate(name.trim());
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-text-muted">
              {s.server.settings.passkeyName}
            </span>
            <Input
              autoFocus
              autoComplete="off"
              maxLength={80}
              placeholder={s.server.settings.passkeyNamePlaceholder}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {registerMutation.isError && (
            <p role="alert" className="rounded-lg bg-error/10 px-3 py-2 text-[11px] text-error">
              {registerMutation.error instanceof DOMException &&
              registerMutation.error.name === "NotAllowedError"
                ? s.server.settings.passkeyCancelled
                : s.server.settings.passkeySetupFailed}
            </p>
          )}
          <Button type="submit" disabled={!name.trim() || registerMutation.isPending}>
            {registerMutation.isPending
              ? s.server.settings.passkeyWaiting
              : s.server.settings.passkeyCreate}
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={remove !== null}
        onClose={() => {
          if (deleteMutation.isPending) return;
          setRemove(null);
          deleteMutation.reset();
        }}
        eyebrow={s.server.settings.passkeyEyebrow}
        title={s.server.settings.passkeyRemoveTitle}
        subtitle={remove?.name}
      >
        <ConfirmView
          description={s.server.settings.passkeyRemoveNote}
          confirmLabel={s.server.settings.passkeyRemove}
          danger
          pending={deleteMutation.isPending}
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            if (remove) deleteMutation.mutate({ path: { credentialId: remove.id } });
          }}
        />
      </Sheet>
    </>
  );
}
