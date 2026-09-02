import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery } from "@tanstack/react-query";
import { AsyncState } from "../components/AsyncState";
import { Button } from "../ui/Button";
import { IconArrowDown, IconArrowUp, IconPeople, IconPlus, IconSearch, IconSort } from "../ui/icons";
import { CardList, CardRow } from "../ui/Card";
import { Sheet } from "../ui/Sheet";
import { pluralTemplate, useStrings, type Dict } from "../i18n";
import { useConnectionState } from "../realtime";
import { useUsersTopic, findQuotaEntry } from "./useUsersTopic";
import { useDebouncedValue } from "./useDebouncedValue";
import { useNow } from "./useNow";
import { UserCard } from "./UserCard";
import { UserActionSheet } from "./UserActionSheet";
import { UserFormSheet } from "./UserFormSheet";
import { PersonInspector } from "./PersonInspector";
import { getTelemtWebAccessOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import { webAccessUsernames } from "./webAccess.helpers";
import {
  computeUserStatus,
  countUserFilters,
  filterUsersByQuery,
  getStoredUserSort,
  getUserQuota,
  matchesUserFilter,
  setStoredUserSort,
  nextSortState,
  sortPresetOf,
  sortUsers,
  SORT_PRESET_ORDER,
  type UserFilter,
  type UserFilterInput,
  type UserSortPreset,
} from "./users.helpers";
import type { UsersTopicUser } from "../realtime/topics";

type FormTarget = { mode: "create" } | { mode: "edit"; user: UsersTopicUser };
const FILTER_ORDER: readonly UserFilter[] = ["all", "online", "issues"];
const PHONE_LIST_QUERY = "(max-width: 767px)";

export interface PeopleListProps {
  selectedUsername?: string | null;
}

// View state survives the phone route temporarily replacing the list with
// a detail screen. It contains no user data or credentials.
const savedView = { search: "", filter: "all" as UserFilter, scrollOffset: 0, returnUsername: null as string | null };

export function PeopleList({ selectedUsername = null }: PeopleListProps) {
  const s = useStrings();
  const topic = useUsersTopic();
  const webAccessQuery = useQuery(getTelemtWebAccessOptions());
  const connection = useConnectionState();
  const now = useNow();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const phoneListLayout = usePhoneListLayout();
  const [search, setSearch] = useState(savedView.search);
  const debouncedSearch = useDebouncedValue(search);
  const [filter, setFilter] = useState<UserFilter>(savedView.filter);
  const [sort, setSort] = useState(() => getStoredUserSort());
  const [actionUser, setActionUser] = useState<UsersTopicUser | null>(null);
  const [swipedUsername, setSwipedUsername] = useState<string | null>(null);
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [gestureHintVisible, setGestureHintVisible] = useState(true);
  const activePreset = sortPresetOf(sort);
  const sortAscending = sort.direction === "asc";
  const sortChipLabel = sortLabelFor(s, activePreset, true, sortAscending);

  function updateSort(next: typeof sort) {
    setSort(next);
    setStoredUserSort(next);
  }

  const webUsernames = useMemo(() => webAccessUsernames(webAccessQuery.data), [webAccessQuery.data]);
  const filterOrder = webAccessQuery.data?.vhosts.length ? [...FILTER_ORDER, "web" as const] : FILTER_ORDER;
  const entries = useMemo<UserFilterInput<UsersTopicUser>[]>(
    () => topic.users.map((user) => ({
      user,
      status: computeUserStatus(user, getUserQuota(user, findQuotaEntry(topic.quota, user.username)), now),
      webAccess: webUsernames.has(user.username),
    })),
    [topic.users, topic.quota, now, webUsernames],
  );
  const counts = useMemo(() => countUserFilters(entries), [entries]);
  const visibleUsers = useMemo(() => {
    const kept = entries.filter((entry) => matchesUserFilter(entry, filter)).map((entry) => entry.user);
    return sortUsers(filterUsersByQuery(kept, debouncedSearch), sort);
  }, [entries, filter, debouncedSearch, sort]);
  const inspectedUsername = selectedUsername ?? (!phoneListLayout ? visibleUsers[0]?.username : null);
  const isNarrowed = debouncedSearch.trim().length > 0 || filter !== "all";
  // TanStack Virtual exposes an imperative object by design; React Compiler
  // must leave this component un-memoized rather than freeze its measurements.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visibleUsers.length,
    getScrollElement: () => scrollRef.current,
    // The phone card has two metric rows; desktop/tablet keep one compact
    // table row. Matching the first estimate to the CSS layout prevents the
    // virtualizer from shifting the saved position while those rows measure.
    estimateSize: () => phoneListLayout ? 94 : 75,
    overscan: 6,
    initialOffset: savedView.scrollOffset,
    getItemKey: (index) => visibleUsers[index]?.username ?? index,
  });

  useEffect(() => {
    const username = savedView.returnUsername;
    if (!username || topic.isPending || visibleUsers.length === 0) return;
    const index = visibleUsers.findIndex((user) => user.username === username);
    savedView.returnUsername = null;
    if (index < 0) return;

    // After a mobile detail route unmounts the list, return to the person the
    // operator opened. Anchoring to identity is stable even when live activity
    // changes the sort order while the detail screen is open.
    const frame = window.requestAnimationFrame(() => {
      virtualizer.scrollToIndex(index, { align: "center" });
      savedView.scrollOffset = scrollRef.current?.scrollTop ?? savedView.scrollOffset;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [topic.isPending, visibleUsers, virtualizer]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  function setSearchValue(value: string) {
    savedView.search = value;
    setSearch(value);
  }

  function setFilterValue(value: UserFilter) {
    savedView.filter = value;
    savedView.scrollOffset = 0;
    setFilter(value);
    virtualizer.scrollToOffset(0);
  }

  function openPerson(user: UsersTopicUser) {
    setSwipedUsername(null);
    savedView.scrollOffset = scrollRef.current?.scrollTop ?? 0;
    if (phoneListLayout) savedView.returnUsername = user.username;
    navigate({ to: "/people/$username", params: { username: user.username } });
  }

  function openPersonAccess(user: UsersTopicUser) {
    try { window.sessionStorage.setItem("telemt-panel:people:initial-tab", "access"); } catch { /* storage is optional */ }
    openPerson(user);
  }

  function openCreatedPersonAccess(username: string) {
    try { window.sessionStorage.setItem("telemt-panel:people:initial-tab", "access"); } catch { /* storage is optional */ }
    savedView.returnUsername = username;
    navigate({ to: "/people/$username", params: { username } });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-0 pb-0 md:px-4 md:pb-4">
      <header className="flex shrink-0 items-center justify-between gap-4 px-4 py-3 md:px-0 md:py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="people-page-icon hidden sm:grid"><IconPeople className="h-5 w-5" /></span>
          <div className="min-w-0">
            <span className="hidden text-micro font-semibold text-text-faint sm:block">{s.people.accessManagement}</span>
            <div className="flex items-baseline gap-2"><h1 className="text-title font-extrabold tracking-tight text-text">{s.people.title}</h1><span className="font-mono text-meta tabular-nums text-text-muted">{counts.all}</span></div>
          </div>
        </div>
        <Button onClick={() => setFormTarget({ mode: "create" })}><IconPlus className="h-4 w-4" />{s.people.create}</Button>
      </header>

      <div className="flex min-h-0 flex-1 gap-3">
        <section className="people-list-pane flex min-w-0 flex-1 flex-col">
          <div className={`people-toolbar ${inspectedUsername ? "has-inspector" : ""}`}>
            <label className="people-search-control">
              <IconSearch className="h-4 w-4 shrink-0" />
              <input ref={searchRef} value={search} onChange={(event) => setSearchValue(event.target.value)} placeholder={s.people.searchPlaceholder} aria-label={s.people.searchPlaceholder} autoCapitalize="off" autoCorrect="off" />
              <kbd>⌘ K</kbd>
            </label>
            <div className="people-filter-group no-scrollbar" role="tablist" aria-label={s.people.filterLabel}>
              {filterOrder.map((key) => <button key={key} type="button" role="tab" className="people-filter-button" aria-selected={filter === key} onClick={() => setFilterValue(key)}>{s.people.filter[key]}<b>{counts[key]}</b></button>)}
            </div>
            <button type="button" className="people-sort-button" aria-label={sortChipLabel} onClick={() => setSortSheetOpen(true)}><IconSort className="h-4 w-4" /><span>{s.people.sortPreset[activePreset]}</span><SortArrow ascending={sortAscending} /></button>
          </div>

          {gestureHintVisible && <div className="people-mobile-hint"><span>↤</span><p><strong>{s.people.gestureHintTitle}</strong> {s.people.gestureHintBody}</p><button type="button" aria-label={s.common.close} onClick={() => setGestureHintVisible(false)}>×</button></div>}

          <div className="people-table-head" aria-hidden="true"><span>{s.people.tableUser}</span><span>{s.people.tableNow}</span><span>{s.shell.traffic}</span><span>{s.people.tableAccess}</span></div>

          <div ref={scrollRef} className="people-list-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain" onScroll={(event) => { savedView.scrollOffset = event.currentTarget.scrollTop; }}>
            <AsyncState
              isPending={topic.isPending}
              isError={topic.isError}
              errorCode={topic.errorCode ?? undefined}
              data={visibleUsers}
              isEmpty={(data) => data.length === 0}
              emptyTitle={isNarrowed ? s.common.empty : s.people.emptyTitle}
              emptyDescription={isNarrowed ? undefined : s.people.emptyDescription}
              emptyAction={isNarrowed ? undefined : <Button onClick={() => setFormTarget({ mode: "create" })}>{s.people.create}</Button>}
              stale={topic.stale || connection.stale}
              onRetry={connection.retry}
              skeleton={<PeopleListSkeleton />}
            >
              {(users) => (
                <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                  {virtualizer.getVirtualItems().map((item) => {
                    const user = users[item.index];
                    if (!user) return null;
                    return (
                      <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
                        <UserCard
                          user={user}
                          quotaEntry={findQuotaEntry(topic.quota, user.username)}
                          now={now}
                          selected={user.username === inspectedUsername}
                          gesturesEnabled={phoneListLayout}
                          swipeOpen={swipedUsername === user.username}
                          onOpen={() => openPerson(user)}
                          onAccess={() => openPersonAccess(user)}
                          onActions={() => { setSwipedUsername(null); setActionUser(user); }}
                          onSwipeOpen={() => setSwipedUsername(user.username)}
                          onSwipeClose={() => setSwipedUsername((current) => current === user.username ? null : current)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </AsyncState>
          </div>

          <footer className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-t border-border px-4 text-micro text-text-faint">
            <span>{isNarrowed ? `${visibleUsers.length} / ${counts.all}` : pluralTemplate(s, counts.all, s.people.recordsCount)}<span className="hidden sm:inline"> · {s.people.searchWholeSet}</span></span>
            <span className="hidden items-center gap-1.5 sm:flex"><i className="h-1.5 w-1.5 rounded-full bg-accent" />{s.people.domRowsPrefix} <strong className="text-text-muted">{virtualizer.getVirtualItems().length}</strong> {s.people.domRowsSuffix}</span>
          </footer>
        </section>

        {inspectedUsername && <PersonInspector username={inspectedUsername} onClose={() => navigate({ to: "/people" })} onEdit={(user) => setFormTarget({ mode: "edit", user })} />}
      </div>

      <UserActionSheet open={actionUser !== null} user={actionUser} onClose={() => setActionUser(null)} onEdit={(user) => setFormTarget({ mode: "edit", user })} />
      <Sheet open={sortSheetOpen} onClose={() => setSortSheetOpen(false)} title={s.people.sortLabel}>
        <CardList>
          {SORT_PRESET_ORDER.map((preset) => {
            const active = activePreset === preset;
            const ascending = active && sortAscending;
            return <CardRow key={preset}><button type="button" className="flex min-h-[44px] flex-1 items-center gap-2 text-left text-row text-text" aria-label={sortLabelFor(s, preset, active, ascending)} onClick={() => { updateSort(nextSortState(sort, preset)); setSortSheetOpen(false); }}><span className="flex-1">{s.people.sortPreset[preset]}</span>{active && <span className="flex items-center gap-1 text-meta text-text-muted">{ascending ? s.people.sortAscending : s.people.sortDescending}<SortArrow ascending={ascending} /></span>}</button></CardRow>;
          })}
        </CardList>
      </Sheet>
      <UserFormSheet open={formTarget !== null} mode={formTarget?.mode ?? "create"} user={formTarget?.mode === "edit" ? formTarget.user : null} onClose={() => setFormTarget(null)} onConfigureWeb={openCreatedPersonAccess} />
    </div>
  );
}

function subscribePhoneListLayout(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const media = window.matchMedia(PHONE_LIST_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function getPhoneListLayout(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(PHONE_LIST_QUERY).matches;
}

function usePhoneListLayout(): boolean {
  return useSyncExternalStore(subscribePhoneListLayout, getPhoneListLayout, () => false);
}

function sortLabelFor(s: Dict, preset: UserSortPreset, active: boolean, ascending: boolean): string {
  const direction = active ? `, ${ascending ? s.people.sortAscending : s.people.sortDescending}` : "";
  return `${s.people.sortLabel}: ${s.people.sortPreset[preset]}${direction}`;
}

function SortArrow({ ascending }: { ascending: boolean }) {
  return ascending ? <IconArrowUp className="h-3 w-3" /> : <IconArrowDown className="h-3 w-3" />;
}

function PeopleListSkeleton() {
  return <div className="flex flex-col">{[0, 1, 2, 3, 4].map((index) => <div key={index} className="flex min-h-[78px] items-center gap-3 border-b border-border px-4"><div className="h-10 w-10 shrink-0 animate-pulse rounded-xl bg-surface-2" /><div className="flex-1"><div className="h-3.5 w-28 animate-pulse rounded bg-surface-2" /><div className="mt-2 h-3 w-44 animate-pulse rounded bg-surface-2" /></div></div>)}</div>;
}
