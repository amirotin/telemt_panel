import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { errorMessage, useStrings } from "../../i18n";
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
import { LanguageToggle } from "../../i18n";
import { DisplayModeSwitch, useDisplayMode, visibleFor } from "../../display-mode";
import { useLogout } from "../../auth/useLogout";
import { formatAuditTimestamp } from "../../journal/timestamp.helpers";
import {
  listSessionsOptions,
  listSessionsQueryKey,
  revokeSessionMutation,
  revokeOtherSessionsMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import { sessionDeviceLabel, sessionUserAgentRaw, sortSessions } from "./sessions.helpers";

// SettingsPage — /server/settings (06-ui.md §Сервер): sessions/devices,
// theme, display mode, sign out. No passkeys/TOTP
// slots — ruling R1 defers those to M4.
//
// Sign out sits in a separate error-tinted block at the bottom.
export function SettingsPage() {
  const s = useStrings();
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery(listSessionsOptions());
  const logout = useLogout();
  const { mode } = useDisplayMode();

  const [confirmRevoke, setConfirmRevoke] = useState<string | "others" | null>(
    null,
  );

  function invalidateSessions() {
    queryClient.invalidateQueries({ queryKey: listSessionsQueryKey() });
  }

  const revokeMutation = useMutation({
    ...revokeSessionMutation(),
    onSuccess: () => {
      pushToast(s.server.settings.sessionRevoked, "ok");
      setConfirmRevoke(null);
      invalidateSessions();
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const revokeOthersMutation = useMutation({
    ...revokeOtherSessionsMutation(),
    onSuccess: () => {
      pushToast(s.server.settings.sessionsRevoked, "ok");
      setConfirmRevoke(null);
      invalidateSessions();
    },
    // revokeOtherSessionsMutation's error type is TanStack's DefaultError
    // (openapi.yaml documents no error responses for DELETE
    // /api/auth/sessions), not the typed {code,message} envelope — narrow
    // through apiErrorCode first (journal/LogsTab.tsx's own precedent for
    // this exact "no documented error schema" shape).
    onError: (err) =>
      pushToast(errorMessage(s, apiErrorCode(err) ?? "internal_error"), "error"),
  });

  return (
    <ServerShell title={s.server.settings.title}>
      <Card className="flex flex-col gap-1">
        <CardTitle
          className="pb-1"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmRevoke("others")}
            >
              {s.server.settings.revokeOthers}
            </Button>
          }
        >
          {s.server.settings.sessionsTitle}
        </CardTitle>

        {confirmRevoke === "others" ? (
          <ConfirmView
            description={s.server.settings.revokeOthersConfirm}
            confirmLabel={s.server.settings.revokeOthers}
            danger
            pending={revokeOthersMutation.isPending}
            onCancel={() => setConfirmRevoke(null)}
            onConfirm={() => revokeOthersMutation.mutate({})}
          />
        ) : sessionsQuery.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : sessionsQuery.isError ? (
          <ErrorState
            message={errorMessage(s, 
              apiErrorCode(sessionsQuery.error) ?? "internal_error",
            )}
            onRetry={() => sessionsQuery.refetch()}
          />
        ) : (
          <ul className="flex flex-col">
            {sortSessions(sessionsQuery.data).map((session) => {
              const rawAgent = sessionUserAgentRaw(session);
              return (
              <li
                key={session.id}
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
                      {/* title carries the full User-Agent the label was
                          derived from, so identifying an unfamiliar device
                          never needs a round trip to the API. */}
                      <span className="truncate" title={rawAgent ?? undefined}>
                        {sessionDeviceLabel(session, s)}
                      </span>
                      {session.current && (
                        <StatePill state="ok" className="shrink-0 whitespace-nowrap">
                          {s.server.settings.currentSessionLabel}
                        </StatePill>
                      )}
                    </span>
                    <span className="text-micro text-text-faint">
                      {s.server.settings.lastSeen}:{" "}
                      {formatAuditTimestamp(session.last_seen, s)}
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
                  {!session.current && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setConfirmRevoke(session.id)}
                    >
                      {s.server.settings.revoke}
                    </Button>
                  )}
                </div>
                {/* Extended mode spells the agent out in full — the
                    tooltip above is mouse-only, and this is the one screen
                    where "which device is this?" is the whole question. */}
                {rawAgent && visibleFor("extended", mode) && (
                  <p className="break-all font-mono text-micro leading-relaxed text-text-faint">
                    {rawAgent}
                  </p>
                )}
                {confirmRevoke === session.id && (
                  <ConfirmView
                    description={s.server.settings.revokeConfirm}
                    confirmLabel={s.server.settings.revoke}
                    danger
                    pending={revokeMutation.isPending}
                    onCancel={() => setConfirmRevoke(null)}
                    onConfirm={() =>
                      revokeMutation.mutate({ path: { sessionId: session.id } })
                    }
                  />
                )}
              </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{s.server.settings.displayTitle}</CardTitle>
        <LanguageToggle />
        <ThemeToggle />
        <div className="flex flex-col gap-2">
          <SectionLabel>{s.displayMode.label}</SectionLabel>
          <DisplayModeSwitch />
        </div>
      </Card>

      <Card className="flex flex-col gap-2.5 border border-error/25">
        <SectionLabel className="text-error">
          {s.server.settings.dangerZoneTitle}
        </SectionLabel>
        <Button
          variant="danger"
          className="self-start"
          onClick={() => logout.mutate({})}
          disabled={logout.isPending}
        >
          {s.server.settings.signOut}
        </Button>
      </Card>
    </ServerShell>
  );
}
