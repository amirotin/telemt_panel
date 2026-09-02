import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getAuditInfiniteOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import type { AuditEntry } from "../lib/api/generated/types.gen";
import { AsyncState } from "../components/AsyncState";
import { useStrings, type Dict } from "../i18n";
import { apiErrorCode } from "../people/apiError";
import { Button } from "../ui/Button";
import { IconSearch } from "../ui/icons";
import { auditActionFamily, renderAuditTitle } from "./auditActions";
import { formatAuditClock, formatAuditDay } from "./timestamp.helpers";

const PAGE_SIZE = 50;

type ActionFilter = "all" | "session" | "person" | "access" | "config" | "update";

const FILTERS: ActionFilter[] = ["all", "session", "person", "access", "config", "update"];

function filterOf(entry: AuditEntry): Exclude<ActionFilter, "all"> {
  const family = auditActionFamily(entry.action);
  return family === "removal" ? "person" : family;
}

function outcomeLabel(entry: AuditEntry, s: Dict): string {
  return s.journal.actions.outcomes[entry.outcome];
}

function meaningfulDetail(entry: AuditEntry): string | undefined {
  if (!entry.detail || /^ip=\S+$/.test(entry.detail)) return undefined;
  return entry.detail;
}

// ActionsTab presents the panel's own operation audit. It deliberately
// remains separate from Telemt runtime events under Pulse: these rows answer
// who changed what, from where, and whether the panel accepted the action.
export function ActionsTab() {
  const s = useStrings();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ActionFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = useInfiniteQuery({
    refetchOnWindowFocus: false,
    ...getAuditInfiniteOptions({ query: { limit: PAGE_SIZE } }),
    initialPageParam: "",
    getNextPageParam: (lastPage: AuditEntry[]) =>
      lastPage.length < PAGE_SIZE
        ? undefined
        : lastPage[lastPage.length - 1]?.ts,
  });

  const entries = useMemo(() => query.data?.pages.flat() ?? [], [query.data]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (filter !== "all" && filterOf(entry) !== filter) return false;
      if (!needle) return true;
      return [
        renderAuditTitle(entry, s),
        entry.actor,
        entry.target,
        entry.ip,
        entry.detail,
        entry.action,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [entries, filter, s, search]);
  const attentionCount = entries.filter((entry) => entry.outcome === "rejected").length;

  return (
    <section className="journal-actions-pane">
      <header className="journal-audit-summary">
        <div>
          <h2>{s.journal.actions.title}</h2>
          <p>{s.journal.actions.retention}</p>
        </div>
        <div className="journal-audit-counts">
          <span>
            <strong>{entries.length}</strong> {s.journal.actions.loaded}
          </span>
          {attentionCount > 0 && (
            <span className="is-attention">
              <strong>{attentionCount}</strong> {s.journal.actions.attention}
            </span>
          )}
        </div>
      </header>

      <div className="journal-audit-tools">
        <label className="journal-search-control">
          <IconSearch aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={s.journal.actions.searchPlaceholder}
            aria-label={s.journal.actions.searchPlaceholder}
          />
        </label>
        <div className="journal-family-filters" role="group" aria-label={s.journal.actions.filterLabel}>
          {FILTERS.map((id) => {
            const count = id === "all" ? entries.length : entries.filter((entry) => filterOf(entry) === id).length;
            return (
              <button
                key={id}
                type="button"
                className={filter === id ? "is-active" : undefined}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {s.journal.actions.filters[id]} <b>{count}</b>
              </button>
            );
          })}
        </div>
      </div>

      <AsyncState
        isPending={query.isPending}
        isError={query.isError}
        errorCode={apiErrorCode(query.error)}
        data={entries}
        onRetry={() => void query.refetch()}
        isEmpty={(data) => data.length === 0}
        emptyTitle={s.journal.actions.emptyTitle}
        emptyDescription={s.journal.actions.emptyDescription}
      >
        {() => (
          <>
            {filtered.length === 0 ? (
              <div className="journal-no-match">{s.journal.actions.noMatch}</div>
            ) : (
              <ol className="journal-action-timeline">
                {filtered.map((entry) => {
                  const detail = meaningfulDetail(entry);
                  const isExpanded = expanded === entry.id;
                  return (
                    <li key={entry.id} className={`journal-action is-${entry.outcome}`}>
                      <time dateTime={entry.ts}>
                        <strong>{formatAuditClock(entry.ts, s)}</strong>
                        <span>{formatAuditDay(entry.ts, s)}</span>
                      </time>
                      <span className="journal-action-axis" aria-hidden="true"><i /></span>
                      <article className="journal-action-card">
                        <header>
                          <div>
                            <span>{s.journal.actions.filters[filterOf(entry)]}</span>
                            <h3>{renderAuditTitle(entry, s)}</h3>
                          </div>
                          <b>{outcomeLabel(entry, s)}</b>
                        </header>
                        <div className="journal-action-facts">
                          <span><small>{s.journal.actions.actor}</small><strong>{entry.actor || "—"}</strong></span>
                          <span><small>{s.journal.actions.target}</small><strong>{entry.target || entry.subject || "—"}</strong></span>
                          <span><small>{s.journal.actions.ip}</small><strong>{entry.ip || "—"}</strong></span>
                        </div>
                        {detail && (
                          <>
                            <button
                              type="button"
                              className="journal-action-more"
                              aria-expanded={isExpanded}
                              onClick={() => setExpanded(isExpanded ? null : entry.id)}
                            >
                              <span>{isExpanded ? s.journal.actions.hideDetails : s.journal.actions.showDetails}</span>
                              <b aria-hidden="true">{isExpanded ? "−" : "+"}</b>
                            </button>
                            {isExpanded && (
                              <div className="journal-action-detail">
                                <p>{detail}</p>
                                <code>{entry.id}</code>
                              </div>
                            )}
                          </>
                        )}
                      </article>
                    </li>
                  );
                })}
              </ol>
            )}
            {query.hasNextPage && (
              <div className="journal-load-more">
                <Button
                  variant="ghost"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {s.journal.showMore}
                </Button>
              </div>
            )}
          </>
        )}
      </AsyncState>
    </section>
  );
}
