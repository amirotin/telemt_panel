import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/Button";
import { CopyField } from "../ui/CopyField";
import { QR } from "../ui/QR";
import { Skeleton } from "../ui/Skeleton";
import { ErrorState } from "../ui/ErrorState";
import { pushToast } from "../ui/Toast";
import { ru, errorMessage } from "../i18n/ru";
import { copyText } from "../lib/copyText";
import {
  getUserSublinkOptions,
  getUserSublinkQueryKey,
  regenerateUserSublinkMutation,
} from "../lib/api/generated/@tanstack/react-query.gen";
import { apiErrorMessage } from "./apiError";
import { ConfirmView } from "../ui/ConfirmView";
import { refreshUsersAfterMutation } from "./refreshUsersAfterMutation";
import { useRefreshTopic } from "../realtime";

export interface SublinkPanelProps {
  username: string;
  /**
   * Compact layout for the `lg:` Инспектор: the link plus a
   * Копировать / QR / Перевыпуск button row, with the QR revealed on
   * demand instead of always occupying the panel.
   */
  compact?: boolean;
}

// SublinkPanel — the "Поделиться доступом" content shared between the
// action sheet (list), the detail screen and the desktop inspector
// (04-subpage.md / 06-ui.md §Люди): fetch, copy, QR, and "перевыпустить"
// (regenerate) for one user's subscription-page URL. One implementation so
// every entry point stays in sync rather than drifting apart.
//
// "Перевыпустить" immediately invalidates the currently distributed
// link (04-subpage.md: rotating the nonce revokes the old token) — a
// misclick has real consequences for whoever already has the old link, so
// it goes through the same ConfirmView step as delete/disable/rotate-secret
// rather than firing on a single tap.
export function SublinkPanel({ username, compact = false }: SublinkPanelProps) {
  const queryClient = useQueryClient();
  const refreshTopic = useRefreshTopic();
  const query = useQuery(getUserSublinkOptions({ path: { username } }));
  const [confirming, setConfirming] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const regenerate = useMutation({
    ...regenerateUserSublinkMutation(),
    onSuccess: () => {
      pushToast(ru.people.toast.sublinkRegenerated, "ok");
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: getUserSublinkQueryKey({ path: { username } }) });
      refreshUsersAfterMutation(refreshTopic);
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  if (query.isPending) return <Skeleton className="h-24 w-full" />;

  if (query.isError) {
    const code = query.error?.code;
    const message =
      code === "sublink_unavailable" ? ru.people.share.unavailableNoLink : errorMessage(code ?? "internal_error");
    return <ErrorState message={message} onRetry={() => query.refetch()} />;
  }

  if (!query.data.enabled) {
    return <p className="text-meta text-text-muted">{ru.people.share.unavailableModule}</p>;
  }

  if (confirming) {
    return (
      <ConfirmView
        description={ru.people.share.confirmRegenerate}
        confirmLabel={ru.people.share.regenerate}
        danger
        pending={regenerate.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => regenerate.mutate({ path: { username } })}
      />
    );
  }

  const url = query.data.url;

  if (compact) {
    return (
      <div className="flex flex-col gap-2">
        <div className="break-all rounded-md bg-bg px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-text-muted">
          {url}
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            className="flex-1"
            onClick={async () => {
              const result = await copyText(url);
              pushToast(
                result === "failed" ? ru.common.copyManually : ru.common.copied,
                result === "failed" ? "error" : "ok",
              );
            }}
          >
            {ru.common.copy}
          </Button>
          <Button size="sm" variant="secondary" className="flex-1" onClick={() => setQrOpen((v) => !v)}>
            {ru.people.actions.qr}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="flex-1 text-warn"
            onClick={() => setConfirming(true)}
          >
            {ru.people.share.regenerateShort}
          </Button>
        </div>
        {qrOpen && (
          <div className="flex justify-center pt-1">
            <QR value={url} size={160} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <CopyField value={url} label={ru.people.share.linkLabel} data-testid="sublink-value" />
      <QR value={url} />
      <Button variant="secondary" onClick={() => setConfirming(true)}>
        {ru.people.share.regenerate}
      </Button>
    </div>
  );
}
