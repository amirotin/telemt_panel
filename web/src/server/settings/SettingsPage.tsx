import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { ru, errorMessage } from "../../i18n/ru";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { StatePill } from "../../ui/StatePill";
import { SectionLabel } from "../../ui/SectionLabel";
import { ConfirmView } from "../../ui/ConfirmView";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { IconDevice } from "../../ui/icons";
import { pushToast } from "../../ui/Toast";
import { apiErrorCode, apiErrorMessage } from "../../people/apiError";
import { ThemeToggle } from "../../components/ThemeToggle";
import { DisplayModeSwitch } from "../../display-mode";
import { useLogout } from "../../auth/useLogout";
import { resetLayout } from "../../pulse/layout";
import { formatAuditTimestamp } from "../../journal/timestamp.helpers";
import {
  listSessionsOptions,
  listSessionsQueryKey,
  revokeSessionMutation,
  revokeOtherSessionsMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import { sessionDeviceLabel, sortSessions } from "./sessions.helpers";

// SettingsPage — /server/settings (06-ui.md §Сервер): sessions/devices,
// theme, display mode, dashboard layout reset, sign out. No passkeys/TOTP
// slots — ruling R1 defers those to M4.
//
// The two irreversible-ish actions (сброс раскладки, выход) sit in a
// separate error-tinted block at the bottom rather than being scattered
// among the display preferences — the prototype's own "danger zone" shape.
export function SettingsPage() {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery(listSessionsOptions());
  const logout = useLogout();

  const [confirmRevoke, setConfirmRevoke] = useState<string | "others" | null>(
    null,
  );
  const [confirmResetLayout, setConfirmResetLayout] = useState(false);
  const [layoutResetDone, setLayoutResetDone] = useState(false);

  function invalidateSessions() {
    queryClient.invalidateQueries({ queryKey: listSessionsQueryKey() });
  }

  const revokeMutation = useMutation({
    ...revokeSessionMutation(),
    onSuccess: () => {
      pushToast(ru.server.settings.sessionRevoked, "ok");
      setConfirmRevoke(null);
      invalidateSessions();
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  const revokeOthersMutation = useMutation({
    ...revokeOtherSessionsMutation(),
    onSuccess: () => {
      pushToast(ru.server.settings.sessionsRevoked, "ok");
      setConfirmRevoke(null);
      invalidateSessions();
    },
    // revokeOtherSessionsMutation's error type is TanStack's DefaultError
    // (openapi.yaml documents no error responses for DELETE
    // /api/auth/sessions), not the typed {code,message} envelope — narrow
    // through apiErrorCode first (journal/LogsTab.tsx's own precedent for
    // this exact "no documented error schema" shape).
    onError: (err) =>
      pushToast(errorMessage(apiErrorCode(err) ?? "internal_error"), "error"),
  });

  return (
    <ServerShell title={ru.server.settings.title}>
      <Card className="flex flex-col gap-1">
        <CardTitle
          className="pb-1"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmRevoke("others")}
            >
              {ru.server.settings.revokeOthers}
            </Button>
          }
        >
          {ru.server.settings.sessionsTitle}
        </CardTitle>

        {confirmRevoke === "others" ? (
          <ConfirmView
            description={ru.server.settings.revokeOthersConfirm}
            confirmLabel={ru.server.settings.revokeOthers}
            danger
            pending={revokeOthersMutation.isPending}
            onCancel={() => setConfirmRevoke(null)}
            onConfirm={() => revokeOthersMutation.mutate({})}
          />
        ) : sessionsQuery.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : sessionsQuery.isError ? (
          <ErrorState
            message={errorMessage(
              apiErrorCode(sessionsQuery.error) ?? "internal_error",
            )}
            onRetry={() => sessionsQuery.refetch()}
          />
        ) : (
          <ul className="flex flex-col">
            {sortSessions(sessionsQuery.data).map((s) => (
              <li
                key={s.id}
                className="flex flex-col gap-2 border-b border-border py-2 last:border-b-0"
              >
                <div className="flex min-h-[52px] items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md bg-surface-2 text-[16px] text-text-muted"
                  >
                    <IconDevice />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2 text-[13px] text-text">
                      <span className="truncate">{sessionDeviceLabel(s)}</span>
                      {s.current && (
                        <StatePill state="ok" className="shrink-0 whitespace-nowrap">
                          {ru.server.settings.currentSessionLabel}
                        </StatePill>
                      )}
                    </span>
                    <span className="text-micro text-text-faint">
                      {ru.server.settings.lastSeen}:{" "}
                      {formatAuditTimestamp(s.last_seen)}
                    </span>
                  </div>
                  {/* No revoke action for the current session — revoking it
                      would delete the very cookie this request is
                      authenticated with, which is what "Выйти" already
                      does explicitly; the task brief's "cannot revoke
                      current without logout semantics" is honored by
                      simply not offering this button here rather than
                      special-casing a DELETE the backend itself doesn't
                      reject. */}
                  {!s.current && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setConfirmRevoke(s.id)}
                    >
                      {ru.server.settings.revoke}
                    </Button>
                  )}
                </div>
                {confirmRevoke === s.id && (
                  <ConfirmView
                    description={ru.server.settings.revokeConfirm}
                    confirmLabel={ru.server.settings.revoke}
                    danger
                    pending={revokeMutation.isPending}
                    onCancel={() => setConfirmRevoke(null)}
                    onConfirm={() =>
                      revokeMutation.mutate({ path: { sessionId: s.id } })
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{ru.server.settings.displayTitle}</CardTitle>
        <ThemeToggle />
        <div className="flex flex-col gap-2">
          <SectionLabel>{ru.displayMode.label}</SectionLabel>
          <DisplayModeSwitch />
        </div>
      </Card>

      <Card className="flex flex-col gap-2.5 border border-error/25">
        <SectionLabel className="text-error">
          {ru.server.settings.dangerZoneTitle}
        </SectionLabel>
        {confirmResetLayout ? (
          <ConfirmView
            description={ru.server.settings.resetLayoutConfirm}
            confirmLabel={ru.server.settings.resetLayout}
            danger
            pending={false}
            onCancel={() => setConfirmResetLayout(false)}
            onConfirm={() => {
              resetLayout();
              setConfirmResetLayout(false);
              setLayoutResetDone(true);
              pushToast(ru.server.settings.resetLayoutDone, "ok");
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              onClick={() => setConfirmResetLayout(true)}
            >
              {ru.server.settings.resetLayout}
            </Button>
            <Button
              variant="danger"
              onClick={() => logout.mutate({})}
              disabled={logout.isPending}
            >
              {ru.server.settings.signOut}
            </Button>
          </div>
        )}
        {layoutResetDone && (
          <p className="text-micro text-text-faint">
            {ru.server.settings.resetLayoutDone}
          </p>
        )}
      </Card>
    </ServerShell>
  );
}
