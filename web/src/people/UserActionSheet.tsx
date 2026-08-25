import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sheet } from "../ui/Sheet";
import { Button } from "../ui/Button";
import { CopyField } from "../ui/CopyField";
import { QR } from "../ui/QR";
import { pushToast } from "../ui/Toast";
import { useStrings } from "../i18n";
import { useCaps } from "../caps/useCaps";
import {
  deleteUserMutation,
  resetUserQuotaMutation,
  rotateUserSecretMutation,
  setUserEnabledMutation,
} from "../lib/api/generated/@tanstack/react-query.gen";
import { apiErrorMessage } from "./apiError";
import { pickTelegramLink, isSafeTelegramLink } from "./linkSelection";
import { SublinkPanel } from "./SublinkPanel";
import { ConfirmView } from "../ui/ConfirmView";
import { refreshUsersAfterMutation } from "./refreshUsersAfterMutation";
import { useRefreshTopic } from "../realtime";
import {
  intentToView,
  type ActionSheetIntent,
  type ActionSheetView,
} from "./actionSheet.helpers";
import type { UsersTopicUser } from "../realtime/topics";

// ActionSheetIntent is re-exported so callers keep importing the sheet's
// own vocabulary from the sheet.
export type { ActionSheetIntent };

export interface UserActionSheetProps {
  open: boolean;
  user: UsersTopicUser | null;
  onClose: () => void;
  onEdit: (user: UsersTopicUser) => void;
  /** Called after a successful delete — the caller navigates away from the detail page, if applicable. */
  onDeleted?: (username: string) => void;
  /** Which step the sheet opens at (default: the action menu). */
  intent?: ActionSheetIntent;
}

// UserActionSheet is the "⋮"/long-press action sheet for one user
// (06-ui.md §Люди): Поделиться (primary), QR, Открыть в Telegram, Изменить,
// Сбросить квоту, Отключить/Включить, Удалить — shared between the list
// (People) and the detail screen so the action set/behavior never drifts
// between the two entry points.
export function UserActionSheet({
  open,
  user,
  onClose,
  onEdit,
  onDeleted,
  intent = "menu",
}: UserActionSheetProps) {
  const s = useStrings();
  // Seeded from the intent, never re-derived: "which step am I on" belongs
  // to one opening of the sheet, and a live `user` update from the SSE
  // topic must not knock the admin out of a half-finished confirmation.
  // Callers that can change the intent between openings (the Инспектор's
  // three action buttons) remount the sheet with `key={intent}` so this
  // initializer runs again — cheaper and less surprising than an effect
  // that writes state back on every open.
  const [view, setView] = useState<ActionSheetView>(() => intentToView(intent, user));
  const caps = useCaps();
  const refreshTopic = useRefreshTopic();

  function close() {
    setView({ kind: "menu" });
    onClose();
  }

  const deleteMutation = useMutation({
    ...deleteUserMutation(),
    onSuccess: () => {
      pushToast(s.people.toast.deleted, "ok");
      onDeleted?.(user!.username);
      close();
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const resetQuotaMutation = useMutation({
    ...resetUserQuotaMutation(),
    onSuccess: () => {
      pushToast(s.people.toast.quotaReset, "ok");
      close();
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const setEnabledMutation = useMutation({
    ...setUserEnabledMutation(),
    onSuccess: (data) => {
      pushToast(data.enabled ? s.people.toast.enabled : s.people.toast.disabled, "ok");
      close();
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const rotateSecretMutation = useMutation({
    ...rotateUserSecretMutation(),
    onSuccess: (data) => {
      pushToast(s.people.toast.secretRotated, "ok");
      setView({ kind: "new-secret", secret: data.secret });
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  if (!user) return null;

  const title =
    view.kind === "menu"
      ? s.people.actions.menu
      : view.kind === "share"
        ? s.people.share.title
        : view.kind === "qr"
          ? s.people.actions.qr
          : view.kind === "new-secret"
            ? s.people.newSecret.title
            : user.username;

  return (
    <Sheet open={open} onClose={close} title={title}>
      {view.kind === "menu" && (
        <div className="flex flex-col gap-2">
          <Button onClick={() => setView({ kind: "share" })}>{s.people.actions.share}</Button>
          <Button variant="secondary" onClick={() => setView({ kind: "qr" })}>
            {s.people.actions.qr}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              const link = pickTelegramLink(user.links);
              if (!link) {
                pushToast(s.people.actions.noTelegramLink, "error");
                return;
              }
              if (!isSafeTelegramLink(link)) {
                pushToast(s.people.actions.unsafeTelegramLink, "error");
                return;
              }
              window.location.href = link;
            }}
          >
            {s.people.actions.openTelegram}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onEdit(user);
              close();
            }}
          >
            {s.people.actions.edit}
          </Button>
          <Button variant="secondary" onClick={() => setView({ kind: "confirm-reset-quota" })}>
            {s.people.actions.resetQuota}
          </Button>
          <div className="flex flex-col gap-1">
            <Button
              variant="secondary"
              disabled={!caps.data?.capabilities.user_enable_disable}
              onClick={() =>
                setView({ kind: "confirm-toggle-enabled", nextEnabled: !user.enabled })
              }
            >
              {user.enabled ? s.people.actions.disable : s.people.actions.enable}
            </Button>
            {caps.data && !caps.data.capabilities.user_enable_disable && (
              <p className="text-xs text-text-faint">{s.gated.hints.user_enable_disable}</p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Button
              variant="secondary"
              disabled={!caps.data?.capabilities.rotate_secret}
              onClick={() => setView({ kind: "confirm-rotate-secret" })}
            >
              {s.people.actions.rotateSecret}
            </Button>
            {caps.data && !caps.data.capabilities.rotate_secret && (
              <p className="text-xs text-text-faint">{s.gated.hints.rotate_secret}</p>
            )}
          </div>
          <Button variant="danger" onClick={() => setView({ kind: "confirm-delete" })}>
            {s.people.actions.delete}
          </Button>
        </div>
      )}

      {view.kind === "share" && <SublinkPanel username={user.username} />}

      {view.kind === "qr" && <TelegramQRView user={user} />}

      {view.kind === "confirm-delete" && (
        <ConfirmView
          description={s.people.actions.confirmDeleteDescription}
          confirmLabel={s.people.actions.delete}
          danger
          pending={deleteMutation.isPending}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() => deleteMutation.mutate({ path: { username: user.username } })}
        />
      )}

      {view.kind === "confirm-reset-quota" && (
        <ConfirmView
          description={s.people.actions.confirmResetQuota}
          confirmLabel={s.people.actions.resetQuota}
          pending={resetQuotaMutation.isPending}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() => resetQuotaMutation.mutate({ path: { username: user.username } })}
        />
      )}

      {view.kind === "confirm-toggle-enabled" && (
        <ConfirmView
          description={
            view.nextEnabled ? s.people.actions.confirmEnable : s.people.actions.confirmDisable
          }
          confirmLabel={
            view.nextEnabled ? s.people.actions.enable : s.people.actions.disable
          }
          danger={!view.nextEnabled}
          pending={setEnabledMutation.isPending}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() =>
            setEnabledMutation.mutate({
              path: { username: user.username },
              body: { enabled: view.nextEnabled },
            })
          }
        />
      )}

      {view.kind === "confirm-rotate-secret" && (
        <ConfirmView
          description={s.people.actions.confirmRotateSecret}
          confirmLabel={s.people.actions.rotateSecret}
          danger
          pending={rotateSecretMutation.isPending}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() => rotateSecretMutation.mutate({ path: { username: user.username } })}
        />
      )}

      {view.kind === "new-secret" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-warn">{s.people.newSecret.warning}</p>
          <CopyField value={view.secret} label={s.people.form.secret} />
          <Button onClick={close}>{s.people.newSecret.close}</Button>
        </div>
      )}
    </Sheet>
  );
}

function TelegramQRView({ user }: { user: UsersTopicUser }) {
  const s = useStrings();
  const link = pickTelegramLink(user.links);
  if (!link) return <p className="text-sm text-text-muted">{s.people.actions.noTelegramLink}</p>;
  return (
    <div className="flex flex-col gap-3">
      <CopyField value={link} />
      <QR value={link} />
    </div>
  );
}

