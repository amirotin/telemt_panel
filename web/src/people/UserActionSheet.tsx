import { useContext, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sheet } from "../ui/Sheet";
import { Button } from "../ui/Button";
import { CopyField } from "../ui/CopyField";
import { QR } from "../ui/QR";
import { pushToast } from "../ui/Toast";
import { useStrings } from "../i18n";
import { useCaps } from "../caps/useCaps";
import {
  deleteUserMutation,
  resetUserTrafficMutation,
  resetUserQuotaMutation,
  rotateUserSecretMutation,
  setUserEnabledMutation,
} from "../lib/api/generated/@tanstack/react-query.gen";
import { apiErrorMessage } from "./apiError";
import { collectConnectionLinks, selectPrimaryConnectionLink } from "./connectionLinks";
import { PeopleContext } from "./PeopleContext";
import { useBulkQuota } from "./bulkQuotaContext";
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
import { invalidateTrafficQueries } from "../traffic/trafficInvalidation";
import {IconPeople,IconLink,IconCopy,IconRefresh,IconShield,IconTrash,IconChevronRight} from "../ui/icons";

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
  readOnly?: boolean;
  onOpenPerson?: (user:UsersTopicUser)=>void;
  onOpenAccess?: (user:UsersTopicUser)=>void;
  anchor?: Pick<DOMRect,"top"|"bottom"|"right">;
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
  readOnly = false,
  onOpenPerson,
  onOpenAccess,
  anchor,
}: UserActionSheetProps) {
  const s = useStrings();
  const bulkQuota = useBulkQuota();
  const connectionContext = useContext(PeopleContext);
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
  const queryClient = useQueryClient();

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
      refreshUsersAfterMutation(refreshTopic, queryClient);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const resetQuotaMutation = useMutation({
    ...resetUserQuotaMutation(),
    onSuccess: () => {
      pushToast(s.people.toast.quotaReset, "ok");
      close();
      refreshUsersAfterMutation(refreshTopic, queryClient);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const resetTrafficMutation = useMutation({
    ...resetUserTrafficMutation(),
    onSuccess: async (_data, variables) => {
      pushToast(s.people.toast.trafficReset, "ok");
      close();
      refreshUsersAfterMutation(refreshTopic, queryClient);
      await invalidateTrafficQueries(queryClient, variables.path.username);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const setEnabledMutation = useMutation({
    ...setUserEnabledMutation(),
    onSuccess: (data) => {
      pushToast(data.enabled ? s.people.toast.enabled : s.people.toast.disabled, "ok");
      close();
      refreshUsersAfterMutation(refreshTopic, queryClient);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const rotateSecretMutation = useMutation({
    ...rotateUserSecretMutation(),
    onSuccess: (data) => {
      pushToast(s.people.toast.secretRotated, "ok");
      setView({ kind: "new-secret", secret: data.secret });
      refreshUsersAfterMutation(refreshTopic, queryClient);
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  if (!user) return null;
  const busy=deleteMutation.isPending||resetQuotaMutation.isPending||resetTrafficMutation.isPending||setEnabledMutation.isPending||rotateSecretMutation.isPending;
  const t=s.people.workspace;
  const item=(label:string,note:string,icon:React.ReactNode,onClick:()=>void,disabled=false,tone="")=><button type="button" className={`user-action-item ${tone}`} onClick={onClick} disabled={disabled}>{icon}<span><strong>{label}</strong><small>{note}</small></span><IconChevronRight/></button>;

  const title =
    view.kind === "menu"
      ? user.username
      : view.kind === "share"
        ? s.people.share.title
        : view.kind === "qr"
          ? s.people.actions.qr
          : view.kind === "new-secret"
            ? s.people.newSecret.title
            : user.username;

  return (
    <Sheet open={open} onClose={()=>{if(!busy)close();}} title={title} placement={view.kind==="menu"?"menu":"auto"} anchor={anchor} className={view.kind==="menu"?"user-action-sheet":undefined}>
      {readOnly&&<p className="user-note">{t.readOnly}</p>}
      {view.kind === "menu" && <div className="user-action-groups">
        <section><h3>{t.accessGroup}</h3>
          {onOpenPerson&&item(t.openPerson,t.openNote,<IconPeople/>,()=>{onOpenPerson(user);close();})}
          {onOpenAccess&&item(s.people.detail.linksTitle,t.accessNote,<IconLink/>,()=>{onOpenAccess(user);close();})}
          {item(t.subscription,t.subscriptionNote,<IconCopy/>,()=>setView({kind:"share"}))}
          {item(s.people.actions.edit,t.editUser,<IconPeople/>,()=>{onEdit(user);close();},readOnly)}
          {item(s.people.actions.qr,s.people.actions.openTelegram,<IconLink/>,()=>setView({kind:"qr"}))}
        </section>
        <section><h3>{t.counters}</h3>
          {item(s.people.actions.resetQuota,t.quotaNote,<IconRefresh/>,()=>setView({kind:"confirm-reset-quota"}),readOnly||bulkQuota.running||!caps.data?.capabilities.quota)}
          {item(s.people.actions.resetTraffic,t.trafficNote,<IconRefresh/>,()=>setView({kind:"confirm-reset-traffic"}))}
        </section>
        <section>
          {item(user.enabled?s.people.actions.disable:s.people.actions.enable,user.enabled?t.blockNote:t.enableNote,<IconShield/>,()=>setView({kind:"confirm-toggle-enabled",nextEnabled:!user.enabled}),readOnly||!caps.data?.capabilities.user_enable_disable,"warn")}
          {item(s.people.actions.rotateSecret,s.people.newSecret.warning,<IconRefresh/>,()=>setView({kind:"confirm-rotate-secret"}),readOnly||!caps.data?.capabilities.rotate_secret)}
          {item(s.people.actions.delete,t.deleteNote,<IconTrash/>,()=>setView({kind:"confirm-delete"}),readOnly,"danger")}
        </section>
      </div>}

      {view.kind === "share" && <SublinkPanel username={user.username} />}

      {view.kind === "qr" && <TelegramQRView user={user} />}

      {view.kind === "confirm-delete" && (
        <ConfirmView
          description={s.people.actions.confirmDeleteDescription + (connectionContext.profiles.get(user.username)?.length ? " " + s.people.webAccess.deleteWarning : "")}
          confirmLabel={s.people.actions.delete}
          danger
          pending={deleteMutation.isPending}
          disabled={readOnly}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() => deleteMutation.mutate({ path: { username: user.username } })}
        />
      )}

      {view.kind === "confirm-reset-quota" && (
        <ConfirmView
          description={s.people.actions.confirmResetQuota}
          confirmLabel={s.people.actions.resetQuota}
          pending={resetQuotaMutation.isPending}
          disabled={readOnly||bulkQuota.running||!caps.data?.capabilities.quota}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() => resetQuotaMutation.mutate({ path: { username: user.username } })}
        />
      )}

      {view.kind === "confirm-reset-traffic" && (
        <ConfirmView
          description={s.people.actions.confirmResetTraffic}
          confirmLabel={s.people.actions.resetTraffic}
          danger
          pending={resetTrafficMutation.isPending}
          onCancel={() => setView({ kind: "menu" })}
          onConfirm={() => resetTrafficMutation.mutate({ path: { username: user.username }, body: { confirm: true } })}
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
          disabled={readOnly||!caps.data?.capabilities.user_enable_disable}
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
          disabled={readOnly||!caps.data?.capabilities.rotate_secret}
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
  const context = useContext(PeopleContext);
  const link = selectPrimaryConnectionLink(collectConnectionLinks(user.links, context.profiles.get(user.username), context.mtprotoListener))?.url;
  if (!link) return <p className="text-sm text-text-muted">{s.people.actions.noTelegramLink}</p>;
  return (
    <div className="flex flex-col gap-3">
      <CopyField value={link} />
      <QR value={link} />
      <a className="tap-target inline-flex items-center justify-center rounded-lg bg-accent/10 p-3 text-accent" href={link}>{s.people.actions.openTelegram}</a>
    </div>
  );
}
