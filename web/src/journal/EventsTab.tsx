import { useInfiniteQuery } from "@tanstack/react-query";
import { getAuditInfiniteOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import { AsyncState } from "../components/AsyncState";
import { Button } from "../ui/Button";
import { ru } from "../i18n/ru";
import { apiErrorCode } from "../people/apiError";
import { renderAuditAction } from "./auditActions";
import { formatAuditTimestamp } from "./timestamp.helpers";
import type { AuditEntry } from "../lib/api/generated/types.gen";

const PAGE_SIZE = 50;

// EventsTab — Task 7 deliverable D: the panel's own audit ring
// (GET /api/audit), newest first, paged with "показать ещё" over the
// documented `before` cursor (an entry's own `ts` — api/openapi.yaml's
// getAudit doc comment). A page shorter than PAGE_SIZE means the ring is
// exhausted, so getNextPageParam stops there instead of looping on an
// always-empty next page.
export function EventsTab() {
  const query = useInfiniteQuery({
    ...getAuditInfiniteOptions({ query: { limit: PAGE_SIZE } }),
    // "" (not undefined) — the generated TPageParam type excludes
    // undefined; the queryFn only ever forwards a truthy `before` anyway
    // (createInfiniteParams merges pageParam into `query.before`, and the
    // backend treats an empty `before` identically to an absent one —
    // internal/httpapi/audit_handler.go's `if raw != ""` check), so this
    // sentinel reaches the first request as "no cursor" either way.
    initialPageParam: "",
    getNextPageParam: (lastPage: AuditEntry[]) =>
      lastPage.length < PAGE_SIZE ? undefined : lastPage[lastPage.length - 1]?.ts,
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
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {list.map((entry, index) => (
              <li key={`${entry.ts}-${index}`} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                <span className="tabular-nums text-xs text-text-faint">{formatAuditTimestamp(entry.ts)}</span>
                <span className="text-text">{renderAuditAction(entry)}</span>
                {entry.detail && entry.action !== "user.enabled" && (
                  <span className="text-xs text-text-muted">{entry.detail}</span>
                )}
              </li>
            ))}
          </ul>
          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {ru.journal.showMore}
              </Button>
            </div>
          )}
        </div>
      )}
    </AsyncState>
  );
}
