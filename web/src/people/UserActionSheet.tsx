import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sheet } from "../ui/Sheet";
import { Button } from "../ui/Button";
import { CopyField } from "../ui/CopyField";
import { QR } from "../ui/QR";
import { pushToast } from "../ui/Toast";
import { ru } from "../i18n/ru";
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
      pushToast(ru.people.toast.deleted, "ok");
      onDeleted?.(user!.username);
      close();
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  const resetQuotaMutation = useMutation({
    ...resetUserQuotaMutation(),
    onSuccess: () => {
      pushToast(ru.people.toast.quotaReset, "ok");
      close();
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  const setEnabledMutation = useMutation({
    ...setUserEnabledMutation(),
    onSuccess: (data) => {
      pushToast(data.enabled ? ru.people.toast.enabled : ru.people.toast.disabled, "ok");
      close();
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  const rotateSecretMutation = useMutation({
    ...rotateUserSecretMutation(),
    onSuccess: (data) => {
      pushToast(ru.people.toast.secretRotated, "ok");
      setView({ kind: "new-secret", secret: data.secret });
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  if (!user) return null;

  const title =
    view.kind === "menu"
      ? ru.people.actions.menu
      : view.kind === "share"
        ? ru.people.share.title
        : view.kind === "qr"
          ? ru.people.actions.qr
          : view.kind === "new-secret"
            ? ru.people.newSecret.title
            : user.username;

  return (
    <Sheet open={open} onClose={close} title={title}>
      {view.kind === "menu" && (
        <div className="flex flex-col gap-2">
          <Button onClick={() => setView({ kind: "share" })}>{ru.people.actions.share}</Button>
          <Button variant="secondary" onClick={() => setView({ kind: "qr" })}>
            {ru.people.actions.qr}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              const link = pickTelegramLink(user.links);
              if (!link) {
                pushToast(ru.people.actions.noTelegramLink, "error");
                return;
              }
              if (!isSafeTelegramLink(link)) {
                pushToast(ru.people.actions.unsafeTelegramLink, "error");
                return;
              }
              window.location.href = link;
            }}
          >
            {ru.people.actions.openTelegram}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onEdit(user);
              close();
            }}
          >
            {ru.people.actions.edit}
          </Button>
          <Button variant="secondary" onClick={() => setView({ kind: "confirm-reset-quota" })}>
            {ru.people.actions.resetQuota}
          </Button>
          <div className="flex flex-col gap-1">
            <Button
              variant="secondary"
              disabled={!caps.data?.capabilities.user_enable_disable}
              onClick={() =>
                setView({ kind: "confirm-toggle-enabled", nextEnabled: !user.enabled })
              }
            >
              {user.enabled ? ru.people.actions.disable : ru.people.actions.enable}
            </Button>
            {caps.data && !caps.data.capabilities.user_enable_disable && (
              <p className="text-xs text-text-faint">{ru.gated.hints.user_enable_disable}</p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Button
              variant="secondary"
              disabled={!caps.data?.capabilities.rotate_secret}
              onClick={() => setView({ kind: "confirm-rotate-secret" })}
            >
              {ru.people.actions.rotateSecret}
            </Button>
            {caps.data && !caps.data.capabilities.rotate_secret && (
              <p className="text-xs text-text-faint">{ru.gated.hints.rotate_secret}</p>
            )}
          </div>
          <Button variant="danger" onClick={() => setView({ kind: "confirm-delete" })}>
            {ru.people.actions.delete}
          </Button>
        </div>
      )}

      {view.kind === "share" && <SublinkPanel username={user.username} />}

      {view.kind === "qr" && <TelegramQRView user={user} />}

      {view.kind === "confirm-delete" && (
        <ConfirmView
          description={ru.people.actions.confirmDeleteDescription}
          confirmLabel={ru.people.actions.delete}
          danger
          pending={deleteMutation.isPending}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() => deleteMutation.mutate({ path: { username: user.username } })}
        />
      )}

      {view.kind === "confirm-reset-quota" && (
        <ConfirmView
          description={ru.people.actions.confirmResetQuota}
          confirmLabel={ru.people.actions.resetQuota}
          pending={resetQuotaMutation.isPending}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() => resetQuotaMutation.mutate({ path: { username: user.username } })}
        />
      )}

      {view.kind === "confirm-toggle-enabled" && (
        <ConfirmView
          description={
            view.nextEnabled ? ru.people.actions.confirmEnable : ru.people.actions.confirmDisable
          }
          confirmLabel={
            view.nextEnabled ? ru.people.actions.enable : ru.people.actions.disable
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
          description={ru.people.actions.confirmRotateSecret}
          confirmLabel={ru.people.actions.rotateSecret}
          danger
          pending={rotateSecretMutation.isPending}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() => rotateSecretMutation.mutate({ path: { username: user.username } })}
        />
      )}

      {view.kind === "new-secret" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-warn">{ru.people.newSecret.warning}</p>
          <CopyField value={view.secret} label={ru.people.form.secret} />
          <Button onClick={close}>{ru.people.newSecret.close}</Button>
        </div>
      )}
    </Sheet>
  );
}

function TelegramQRView({ user }: { user: UsersTopicUser }) {
  const link = pickTelegramLink(user.links);
  if (!link) return <p className="text-sm text-text-muted">{ru.people.actions.noTelegramLink}</p>;
  return (
    <div className="flex flex-col gap-3">
      <CopyField value={link} />
      <QR value={link} />
    </div>
  );
}

