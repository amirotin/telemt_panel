import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import {
  countLabel,
  errorMessage,
  useLocalePreference,
  useStrings,
} from "../../i18n";
import { useTheme } from "../../lib/useTheme";
import { useDisplayMode } from "../../display-mode";
import { Button } from "../../ui/Button";
import { ConfirmView } from "../../ui/ConfirmView";
import { ErrorState } from "../../ui/ErrorState";
import { Sheet } from "../../ui/Sheet";
import { Skeleton } from "../../ui/Skeleton";
import {
  IconChevronRight,
  IconDevice,
  IconDesktop,
  IconLogout,
} from "../../ui/icons";
import { pushToast } from "../../ui/Toast";
import { apiErrorCode, apiErrorMessage } from "../../people/apiError";
import { useLogout } from "../../auth/useLogout";
import { formatAuditTimestamp } from "../../journal/timestamp.helpers";
import {
  listSessionsInfiniteQueryKey,
  listSessionsOptions,
  listSessionsQueryKey,
  revokeSessionMutation,
  revokeOtherSessionsMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { SessionInfo } from "../../lib/api/generated/types.gen";
import { sessionDeviceLabel } from "./sessions.helpers";
import { InterfacePreferences } from "./InterfacePreferences";
import { SessionSheet } from "./SessionSheet";

function SessionGlyph({ session }: { session: SessionInfo }) {
  const mobile = /iphone|ipad|android/i.test(session.user_agent_label ?? "");
  return (
    <span
      aria-hidden="true"
      className={
        session.current
          ? "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ok/12 text-ok"
          : "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"
      }
    >
      {mobile ? <IconDevice /> : <IconDesktop />}
    </span>
  );
}

function MiniInterfacePreview() {
  return (
    <div
      aria-hidden="true"
      className="grid h-[82px] w-[126px] shrink-0 grid-cols-[28px_1fr] overflow-hidden rounded-xl border border-accent/30 bg-bg shadow-xl"
    >
      <div className="border-r border-border p-2">
        <span className="block h-2 w-2 rounded-sm bg-accent/25" />
        <span className="mt-2 block h-1 w-3 rounded-full bg-text-faint/25" />
        <span className="mt-1.5 block h-1 w-3 rounded-full bg-text-faint/20" />
      </div>
      <div className="flex flex-col gap-2 p-3">
        <span className="h-1.5 w-1/2 rounded-full bg-text-faint/30" />
        <span className="h-6 rounded-md bg-surface-2" />
        <span className="h-2 w-3/4 rounded-full bg-accent/15" />
      </div>
    </div>
  );
}

export function SettingsPage() {
  const s = useStrings();
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery(
    listSessionsOptions({ query: { limit: 4 } }),
  );
  const logout = useLogout();
  const [theme] = useTheme();
  const locale = useLocalePreference();
  const { mode } = useDisplayMode();

  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  const [initialSession, setInitialSession] = useState<SessionInfo | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  function invalidateSessions() {
    void queryClient.invalidateQueries({ queryKey: listSessionsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: listSessionsInfiniteQueryKey() });
  }

  const revokeMutation = useMutation({
    ...revokeSessionMutation(),
    onSuccess: () => {
      pushToast(s.server.settings.sessionRevoked, "ok");
      setSessionSheetOpen(false);
      setInitialSession(null);
      invalidateSessions();
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  const revokeOthersMutation = useMutation({
    ...revokeOtherSessionsMutation(),
    onSuccess: () => {
      pushToast(s.server.settings.sessionsRevoked, "ok");
      setConfirmOthers(false);
      invalidateSessions();
    },
    onError: (err) =>
      pushToast(errorMessage(s, apiErrorCode(err) ?? "internal_error"), "error"),
  });

  const page = sessionsQuery.data;
  const currentSession = page?.items.find((session) => session.current) ?? null;
  const recentSessions = page?.items.filter((session) => !session.current).slice(0, 3) ?? [];
  const otherCount = Math.max(0, (page?.total ?? 0) - 1);
  const normalizedMode = mode === "extended" ? "extended" : "basic";

  function openSessionSheet(session: SessionInfo | null) {
    setInitialSession(session);
    setSessionSheetOpen(true);
  }

  return (
    <ServerShell title={s.server.settings.title}>
      <section data-testid="settings-hero" className="overflow-hidden rounded-2xl border border-accent/30 bg-surface">
        <div className="grid lg:grid-cols-[1fr_0.92fr]">
          <div className="flex min-h-[174px] flex-col justify-center bg-[linear-gradient(135deg,color-mix(in_srgb,var(--accent)_10%,transparent),transparent_58%)] px-5 py-6 sm:px-6">
            <span className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-accent">
              {s.server.settings.heroEyebrow}
            </span>
            <h2 className="mt-3 max-w-xl text-[25px] font-extrabold leading-[1.08] tracking-[-0.03em] text-text sm:text-[29px]">
              {s.server.settings.heroTitle}
            </h2>
            <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-text-muted">
              {s.server.settings.heroNote}
            </p>
          </div>
          <div className="flex min-h-[142px] items-center justify-center gap-4 border-t border-border px-5 py-5 lg:border-l lg:border-t-0">
            <MiniInterfacePreview />
            <div className="min-w-0">
              <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-text-faint">
                {s.server.settings.thisDevice}
              </span>
              <strong className="mt-1 block truncate text-[15px] text-text">
                {s.theme[theme]}
              </strong>
              <span className="mt-1 block text-[11px] leading-snug text-text-muted">
                {s.language[locale]} · {s.displayMode[normalizedMode]}
              </span>
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-3 divide-x divide-border border-t border-border">
          <div className="min-w-0 px-3 py-3 sm:px-4">
            <dt className="text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
              {s.server.settings.activeSessionsLabel}
            </dt>
            <dd className="mt-1 font-mono text-[16px] font-bold text-text">
              {page?.total ?? "—"}
            </dd>
            <small className="mt-0.5 block truncate text-[9px] text-text-faint">
              {otherCount > 0
                ? s.server.settings.canEnd.replace("{count}", String(otherCount))
                : s.server.settings.onlyThisDevice}
            </small>
          </div>
          <div className="min-w-0 px-3 py-3 sm:px-4">
            <dt className="text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
              {s.server.settings.devicesLabel}
            </dt>
            <dd className="mt-1 font-mono text-[16px] font-bold text-text">
              {page?.device_count ?? "—"}
            </dd>
            <small className="mt-0.5 block truncate text-[9px] text-text-faint">
              {s.server.settings.devicesNote}
            </small>
          </div>
          <div className="min-w-0 px-3 py-3 sm:px-4">
            <dt className="text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
              {s.server.settings.interfaceLabel}
            </dt>
            <dd className="mt-1 truncate text-[14px] font-bold text-text">
              {s.theme[theme]}
            </dd>
            <small className="mt-0.5 block truncate text-[9px] text-text-faint">
              {s.server.settings.localOnly}
            </small>
          </div>
        </dl>
      </section>

      <div className="grid items-start gap-2.5 lg:grid-cols-[minmax(0,1.35fr)_minmax(330px,0.65fr)]">
        <section data-testid="settings-sessions" className="overflow-hidden rounded-xl bg-surface" aria-labelledby="sessions-title">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5">
            <div>
              <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-text-faint">
                {s.server.settings.panelAccess}
              </span>
              <h2 id="sessions-title" className="mt-1 text-[16px] font-bold text-text">
                {s.server.settings.sessionsTitle}
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {page && (
                <span className="rounded-full bg-accent/10 px-2.5 py-1.5 text-[10px] font-bold text-accent">
                  {countLabel(s, page.total, s.server.settings.activeSessionForms)}
                </span>
              )}
              {otherCount > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirmOthers(true)}
                >
                  {s.server.settings.revokeOthers}
                </Button>
              )}
            </div>
          </header>

          {sessionsQuery.isPending ? (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-[58px] w-full" />
              ))}
            </div>
          ) : sessionsQuery.isError ? (
            <div className="p-4">
              <ErrorState
                message={errorMessage(s, apiErrorCode(sessionsQuery.error) ?? "internal_error")}
                onRetry={() => sessionsQuery.refetch()}
              />
            </div>
          ) : currentSession ? (
            <>
              <button
                type="button"
                onClick={() => openSessionSheet(currentSession)}
                className="flex min-h-[64px] w-full items-center gap-3 bg-ok/5 px-4 py-2.5 text-left hover:bg-ok/8"
              >
                <SessionGlyph session={currentSession} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <strong className="truncate text-[13px] text-text">
                      {sessionDeviceLabel(currentSession, s)}
                    </strong>
                    <small className="shrink-0 rounded-full bg-ok/12 px-2 py-1 text-[9px] font-bold text-ok">
                      {s.server.settings.currentSessionLabel}
                    </small>
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-text-faint">
                    {currentSession.ip || s.server.settings.unknownAddress} · {s.server.settings.activeNow}
                  </span>
                </span>
                <IconChevronRight className="shrink-0 text-accent" aria-hidden="true" />
              </button>

              <div className="flex items-center justify-between gap-3 border-y border-border px-4 py-2.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
                <span>{s.server.settings.recentOtherSessions}</span>
                <small className="font-bold normal-case tracking-normal">
                  {s.server.settings.shownOf
                    .replace("{shown}", String(recentSessions.length))
                    .replace("{total}", String(otherCount))}
                </small>
              </div>

              {recentSessions.length === 0 ? (
                <div className="px-4 py-8 text-center text-[12px] text-text-muted">
                  {s.server.settings.noOtherSessions}
                </div>
              ) : (
                recentSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => openSessionSheet(session)}
                    className="flex min-h-[62px] w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left hover:bg-surface-2"
                  >
                    <SessionGlyph session={session} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-[13px] text-text">
                        {sessionDeviceLabel(session, s)}
                      </strong>
                      <small className="mt-1 block truncate text-[11px] text-text-faint">
                        {session.ip || s.server.settings.unknownAddress} · {formatAuditTimestamp(session.last_seen, s)}
                      </small>
                    </span>
                    <IconChevronRight className="shrink-0 text-accent" aria-hidden="true" />
                  </button>
                ))
              )}

              {otherCount > 0 && (
                <button
                  type="button"
                  onClick={() => openSessionSheet(null)}
                  className="flex min-h-[66px] w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1">
                    <small className="block text-[10px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
                      {s.server.settings.fullList}
                    </small>
                    <strong className="mt-1 block truncate text-[12px] text-accent">
                      {s.server.settings.openAll.replace("{count}", String(otherCount))}
                    </strong>
                  </span>
                  <IconChevronRight className="shrink-0 text-accent" aria-hidden="true" />
                </button>
              )}
            </>
          ) : (
            <div className="p-4 text-[12px] text-text-muted">
              {s.server.settings.noSessionsFound}
            </div>
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-2.5">
          <InterfacePreferences />

          <section className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl bg-surface p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-error/10 text-error" aria-hidden="true">
              <IconLogout />
            </span>
            <div className="min-w-0">
              <span className="block text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
                {s.server.settings.currentSession}
              </span>
              <strong className="mt-0.5 block text-[12px] text-text">
                {s.server.settings.signOutThisDevice}
              </strong>
              <p className="mt-1 text-[10px] leading-snug text-text-faint">
                {s.server.settings.signOutNote}
              </p>
            </div>
            <Button
              variant="danger"
              size="sm"
              className="col-span-2 sm:col-span-1"
              onClick={() => setConfirmLogout(true)}
            >
              {s.server.settings.signOut}
            </Button>
          </section>
        </div>
      </div>

      {sessionSheetOpen && (
        <SessionSheet
          open
          initialSession={initialSession}
          revokePending={revokeMutation.isPending}
          onClose={() => {
            setSessionSheetOpen(false);
            setInitialSession(null);
          }}
          onRevoke={(sessionId) =>
            revokeMutation.mutate({ path: { sessionId } })
          }
        />
      )}

      <Sheet
        open={confirmOthers}
        onClose={() => setConfirmOthers(false)}
        eyebrow={s.server.settings.confirmation}
        title={s.server.settings.revokeOthersConfirmTitle}
        subtitle={s.server.settings.revokeOthersConfirm}
      >
        <ConfirmView
          description={s.server.settings.revokeOthersExplanation.replace(
            "{count}",
            String(otherCount),
          )}
          confirmLabel={s.server.settings.revokeOthers}
          danger
          pending={revokeOthersMutation.isPending}
          onCancel={() => setConfirmOthers(false)}
          onConfirm={() => revokeOthersMutation.mutate({})}
        />
      </Sheet>

      <Sheet
        open={confirmLogout}
        onClose={() => setConfirmLogout(false)}
        eyebrow={s.server.settings.currentSession}
        title={s.server.settings.signOutConfirmTitle}
        subtitle={s.server.settings.signOutNote}
      >
        <ConfirmView
          description={s.server.settings.signOutExplanation}
          confirmLabel={s.server.settings.signOut}
          danger
          pending={logout.isPending}
          onCancel={() => setConfirmLogout(false)}
          onConfirm={() => logout.mutate({})}
        />
      </Sheet>
    </ServerShell>
  );
}
