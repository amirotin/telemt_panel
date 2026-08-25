import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { ru, errorMessage } from "../../i18n/ru";
import { Button } from "../../ui/Button";
import { StatePill } from "../../ui/StatePill";
import { ConfirmView } from "../../ui/ConfirmView";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
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
export function SettingsPage() {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery(listSessionsOptions());
  const logout = useLogout();

  const [confirmRevoke, setConfirmRevoke] = useState<string | "others" | null>(null);
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
    onError: (err) => pushToast(errorMessage(apiErrorCode(err) ?? "internal_error"), "error"),
  });

  return (
    <ServerShell title={ru.server.settings.title}>
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text">{ru.server.settings.sessionsTitle}</h2>
          <Button variant="secondary" onClick={() => setConfirmRevoke("others")}>
            {ru.server.settings.revokeOthers}
          </Button>
        </div>

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
          <ErrorState message={errorMessage("internal_error")} onRetry={() => sessionsQuery.refetch()} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {sortSessions(sessionsQuery.data).map((s) => (
              <li key={s.id} className="flex flex-col gap-2 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2 text-sm text-text">
                      <span className="truncate">{sessionDeviceLabel(s)}</span>
                      {s.current && <StatePill state="ok">{ru.server.settings.currentSessionLabel}</StatePill>}
                    </span>
                    <span className="text-xs text-text-faint">
                      {ru.server.settings.lastSeen}: {formatAuditTimestamp(s.last_seen)}
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
                    <Button variant="ghost" onClick={() => setConfirmRevoke(s.id)}>
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
                    onConfirm={() => revokeMutation.mutate({ path: { sessionId: s.id } })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold text-text">{ru.server.settings.displayTitle}</h2>
        <div className="flex flex-wrap items-end gap-4">
          <ThemeToggle />
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">{ru.displayMode.label}</span>
            <DisplayModeSwitch />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold text-text">{ru.server.settings.dashboardTitle}</h2>
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
          <Button variant="secondary" onClick={() => setConfirmResetLayout(true)}>
            {ru.server.settings.resetLayout}
          </Button>
        )}
        {layoutResetDone && <p className="mt-2 text-xs text-text-faint">{ru.server.settings.resetLayoutDone}</p>}
      </section>

      <Button variant="danger" onClick={() => logout.mutate({})} disabled={logout.isPending}>
        {ru.server.settings.signOut}
      </Button>
    </ServerShell>
  );
}
