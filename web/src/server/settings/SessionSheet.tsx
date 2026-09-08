import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useStrings, errorMessage } from "../../i18n";
import { useDebouncedValue } from "../../people/useDebouncedValue";
import { apiErrorCode } from "../../people/apiError";
import { formatAuditTimestamp } from "../../journal/timestamp.helpers";
import { Button } from "../../ui/Button";
import { ConfirmView } from "../../ui/ConfirmView";
import { ErrorState } from "../../ui/ErrorState";
import { Sheet } from "../../ui/Sheet";
import { Skeleton } from "../../ui/Skeleton";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDesktop,
  IconDevice,
  IconSearch,
} from "../../ui/icons";
import {
  listSessionsInfiniteOptions,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type {
  SessionInfo,
  SessionPage,
} from "../../lib/api/generated/types.gen";
import { sessionDeviceLabel, sessionUserAgentRaw } from "./sessions.helpers";

const PAGE_SIZE = 30;

interface SessionSheetProps {
  open: boolean;
  initialSession: SessionInfo | null;
  revokePending: boolean;
  onClose: () => void;
  onRevoke: (sessionId: string) => void;
}

function SessionIcon({ session }: { session: SessionInfo }) {
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

export function SessionSheet({
  open,
  initialSession,
  revokePending,
  onClose,
  onRevoke,
}: SessionSheetProps) {
  const s = useStrings();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<SessionInfo | null>(initialSession);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const debouncedSearch = useDebouncedValue(search);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const query = useInfiniteQuery({
    ...listSessionsInfiniteOptions({
      query: {
        limit: PAGE_SIZE,
        q: debouncedSearch.trim() || undefined,
      },
    }),
    enabled: open && selected === null,
    initialPageParam: {},
    getNextPageParam: (lastPage: SessionPage) => lastPage.next_cursor ?? undefined,
  });

  const sessions = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data?.pages],
  );
  const total = query.data?.pages[0]?.total ?? 0;

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!open || selected || !target || !query.hasNextPage) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !query.isFetchingNextPage) {
          void query.fetchNextPage();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [open, query, selected]);

  function close() {
    setSearch("");
    setSelected(null);
    setConfirmRevoke(false);
    onClose();
  }

  const title = selected
    ? sessionDeviceLabel(selected, s)
    : s.server.settings.allSessionsTitle;
  const subtitle = selected
    ? `${selected.ip || s.server.settings.unknownAddress} · ${formatAuditTimestamp(selected.last_seen, s)}`
    : s.server.settings.sessionSheetSubtitle
        .replace("{total}", String(total))
        .replace("{loaded}", String(sessions.length));

  return (
    <Sheet
      open={open}
      onClose={close}
      eyebrow={selected ? (selected.current ? s.server.settings.currentSession : s.server.settings.panelSession) : s.server.settings.sessionsTitle}
      title={title}
      subtitle={subtitle}
      className="lg:max-w-[620px]"
      bodyClassName="scrollbar-panel"
    >
      {selected ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setConfirmRevoke(false);
            }}
            className="tap-target -ml-2 inline-flex self-start items-center gap-1 rounded-lg px-2 text-[11px] font-bold text-accent hover:bg-accent/10"
          >
            <IconChevronLeft aria-hidden="true" />
            {s.server.settings.backToSessions}
          </button>

          <div className="flex items-center gap-3 rounded-xl bg-accent/5 p-3">
            <SessionIcon session={selected} />
            <div className="min-w-0">
              <strong className="block truncate text-[15px] text-text">
                {sessionDeviceLabel(selected, s)}
              </strong>
              <span className="mt-1 block text-[11px] text-text-muted">
                {selected.current
                  ? s.server.settings.currentSessionLabel
                  : s.server.settings.otherActiveSession}
              </span>
            </div>
          </div>

          <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-2">
            {[
              [s.server.settings.ipAddress, selected.ip || s.server.settings.unknownAddress],
              [
                s.server.settings.authMethod,
                selected.auth_method === "passkey"
                  ? s.server.settings.authPasskey
                  : s.server.settings.authPassword,
              ],
              [s.server.settings.created, formatAuditTimestamp(selected.created, s)],
              [s.server.settings.lastSeen, formatAuditTimestamp(selected.last_seen, s)],
              [s.server.settings.sessionId, selected.id],
              [
                s.server.settings.stateLabel,
                selected.current
                  ? s.server.settings.currentState
                  : s.server.settings.activeState,
              ],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 bg-surface-2 p-3">
                <dt className="text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
                  {label}
                </dt>
                <dd className="mt-1 truncate font-mono text-[12px] text-text" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {sessionUserAgentRaw(selected) && (
            <div className="break-all rounded-xl bg-bg px-3 py-2.5 font-mono text-[10px] leading-relaxed text-text-faint">
              {sessionUserAgentRaw(selected)}
            </div>
          )}

          {!selected.current &&
            (confirmRevoke ? (
              <ConfirmView
                description={s.server.settings.revokeConfirm}
                confirmLabel={s.server.settings.revoke}
                danger
                pending={revokePending}
                onCancel={() => setConfirmRevoke(false)}
                onConfirm={() => onRevoke(selected.id)}
              />
            ) : (
              <Button variant="danger" onClick={() => setConfirmRevoke(true)}>
                {s.server.settings.revoke}
              </Button>
            ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="relative block">
            <span className="sr-only">{s.server.settings.sessionSearch}</span>
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-faint">
              <IconSearch aria-hidden="true" />
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder={s.server.settings.sessionSearch}
              className="tap-target w-full rounded-lg border border-border bg-bg pl-10 pr-3 text-[13px] text-text outline-none placeholder:text-text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
            />
          </label>

          {query.isPending ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-[62px] w-full" />
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState
              message={errorMessage(s, apiErrorCode(query.error) ?? "internal_error")}
              onRetry={() => query.refetch()}
            />
          ) : sessions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-[12px] text-text-muted">
              {s.server.settings.noSessionsFound}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  data-testid="session-sheet-row"
                  type="button"
                  onClick={() => setSelected(session)}
                  className="flex min-h-[62px] w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-2"
                >
                  <SessionIcon session={session} />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-[13px] text-text">
                      {sessionDeviceLabel(session, s)}
                    </strong>
                    <small className="mt-1 block truncate text-[11px] text-text-faint">
                      {session.ip || s.server.settings.unknownAddress} · {formatAuditTimestamp(session.last_seen, s)}
                    </small>
                  </span>
                  <span className="hidden text-[11px] font-bold text-accent sm:inline">
                    {s.server.settings.details}
                  </span>
                  <IconChevronRight className="shrink-0 text-accent" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}

          <div ref={loadMoreRef} className="flex min-h-11 items-center justify-center">
            {query.isFetchingNextPage ? (
              <span className="text-[11px] text-text-faint">{s.common.loading}</span>
            ) : query.hasNextPage ? (
              <Button variant="secondary" onClick={() => void query.fetchNextPage()}>
                {s.server.settings.loadMoreSessions}
              </Button>
            ) : sessions.length > 0 ? (
              <span className="text-center text-[10px] leading-relaxed text-text-faint">
                {s.server.settings.sessionsShown
                  .replace("{loaded}", String(sessions.length))
                  .replace("{total}", String(total))}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </Sheet>
  );
}
