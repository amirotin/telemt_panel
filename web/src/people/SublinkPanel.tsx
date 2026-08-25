import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/Button";
import { CopyField } from "../ui/CopyField";
import { QR } from "../ui/QR";
import { Skeleton } from "../ui/Skeleton";
import { ErrorState } from "../ui/ErrorState";
import { pushToast } from "../ui/Toast";
import { ru, errorMessage } from "../i18n/ru";
import {
  getUserSublinkOptions,
  getUserSublinkQueryKey,
  regenerateUserSublinkMutation,
} from "../lib/api/generated/@tanstack/react-query.gen";
import { apiErrorMessage } from "./apiError";
import { ConfirmView } from "./ConfirmView";
import { refreshUsersAfterMutation } from "./refreshUsersAfterMutation";
import { useRefreshTopic } from "../realtime";

// SublinkPanel — the "Поделиться доступом" content shared between the
// action sheet (list/table) and the detail screen (04-subpage.md /
// 06-ui.md §Люди): fetch, copy, QR, and "перевыпустить" (regenerate) for
// one user's subscription-page URL. One implementation so both entry
// points stay in sync rather than drifting apart.
//
// "Перевыпустить" immediately invalidates the currently distributed
// link (04-subpage.md: rotating the nonce revokes the old token) — a
// misclick has real consequences for whoever already has the old link, so
// it goes through the same ConfirmView step as delete/disable/rotate-secret
// rather than firing on a single tap.
export function SublinkPanel({ username }: { username: string }) {
  const queryClient = useQueryClient();
  const refreshTopic = useRefreshTopic();
  const query = useQuery(getUserSublinkOptions({ path: { username } }));
  const [confirming, setConfirming] = useState(false);

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
    return <p className="text-sm text-text-muted">{ru.people.share.unavailableModule}</p>;
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

  return (
    <div className="flex flex-col gap-3">
      <CopyField value={query.data.url} label={ru.people.share.linkLabel} />
      <QR value={query.data.url} />
      <Button variant="secondary" onClick={() => setConfirming(true)}>
        {ru.people.share.regenerate}
      </Button>
    </div>
  );
}
