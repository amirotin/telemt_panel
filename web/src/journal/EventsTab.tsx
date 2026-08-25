import type { ComponentType } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getAuditInfiniteOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import { AsyncState } from "../components/AsyncState";
import { Button } from "../ui/Button";
import {
  IconLogout,
  IconSettings,
  IconShield,
  IconTrash,
  IconUpgrade,
  IconUserPlus,
  type IconProps,
} from "../ui/icons";
import { ru } from "../i18n/ru";
import { apiErrorCode } from "../people/apiError";
import {
  auditActionFamily,
  renderAuditAction,
  type AuditFamily,
} from "./auditActions";
import { formatAuditTimestamp } from "./timestamp.helpers";
import type { AuditEntry } from "../lib/api/generated/types.gen";

const PAGE_SIZE = 50;

// The glyph per action family. auditActionFamily owns the classification
// (and its test); this table is only the family → drawing step, so a new
// backend action needs no change here.
const FAMILY_ICONS: Record<AuditFamily, ComponentType<IconProps>> = {
  session: IconLogout,
  person: IconUserPlus,
  removal: IconTrash,
  config: IconSettings,
  update: IconUpgrade,
  access: IconShield,
};

// EventsTab — Task 7 deliverable D: the panel's own audit ring
// (GET /api/audit), newest first, paged with "показать ещё" over the
// documented `before` cursor (an entry's own `ts` — api/openapi.yaml's
// getAudit doc comment). A page shorter than PAGE_SIZE means the ring is
// exhausted, so getNextPageParam stops there instead of looping on an
// always-empty next page.
export function EventsTab() {
  const query = useInfiniteQuery({
    // The tab stays mounted while hidden (so the logs stream survives tab
    // switches) — do not refetch the audit log on every window focus.
    refetchOnWindowFocus: false,
    ...getAuditInfiniteOptions({ query: { limit: PAGE_SIZE } }),
    // "" (not undefined) — the generated TPageParam type excludes
    // undefined; the queryFn only ever forwards a truthy `before` anyway
    // (createInfiniteParams merges pageParam into `query.before`, and the
    // backend treats an empty `before` identically to an absent one —
    // internal/httpapi/audit_handler.go's `if raw != ""` check), so this
    // sentinel reaches the first request as "no cursor" either way.
    initialPageParam: "",
    getNextPageParam: (lastPage: AuditEntry[]) =>
      lastPage.length < PAGE_SIZE
        ? undefined
        : lastPage[lastPage.length - 1]?.ts,
  });

  const entries = query.data?.pages.flat() ?? [];

  return (
    <AsyncState
      isPending={query.isPending}
      isError={query.isError}
      errorCode={apiErrorCode(query.error)}
      data={entries}
      onRetry={() => void query.refetch()}
      isEmpty={(d) => d.length === 0}
      emptyTitle={ru.journal.events.emptyTitle}
      emptyDescription={ru.journal.events.emptyDescription}
    >
      {(list) => (
        <div className="flex flex-col gap-2">
          {/*
            The prototype's event list rather than a bordered table: a round
            icon tile per row, the human sentence, and the time/actor meta
            under it, with the hairline drawn under the *text column* only so
            the icons form an uninterrupted rail down the left edge.
          */}
          <ul className="flex flex-col">
            {list.map((entry, index) => {
              const Glyph = FAMILY_ICONS[auditActionFamily(entry.action)];
              return (
                <li
                  key={`${entry.ts}-${index}`}
                  className="flex items-center gap-3 py-1 last:[&>div]:border-b-0"
                >
                  <span
                    className="inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-[16px] text-text-muted"
                    aria-hidden="true"
                  >
                    <Glyph />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 border-b border-border pt-1 pb-3">
                    <span className="text-[13px] text-text">
                      {renderAuditAction(entry)}
                    </span>
                    <span className="text-micro text-text-muted">
                      <span className="tabular-nums">
                        {formatAuditTimestamp(entry.ts)}
                      </span>
                      {entry.detail &&
                        entry.action !== "user.enabled" &&
                        ` · ${entry.detail}`}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {query.hasNextPage && (
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {ru.journal.showMore}
            </Button>
          )}
        </div>
      )}
    </AsyncState>
  );
}
