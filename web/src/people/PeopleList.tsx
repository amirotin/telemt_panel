import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AsyncState } from "../components/AsyncState";
import { Button } from "../ui/Button";
import { IconArrowDown, IconArrowUp, IconClose, IconPlus, IconSearch, IconSort } from "../ui/icons";
import { PageHeader } from "../ui/PageHeader";
import { CardList, CardRow } from "../ui/Card";
import { Sheet } from "../ui/Sheet";
import { formatNumber, pluralTemplate, useStrings, type Dict } from "../i18n";
import {formatBytes} from "../lib/format";
import { useConnectionState } from "../realtime";
import { useUsersTopic, findQuotaEntry } from "./useUsersTopic";
import { useDebouncedValue } from "./useDebouncedValue";
import { useNow } from "./useNow";
import { UserCard } from "./UserCard";
import { UserActionSheet, type ActionSheetIntent } from "./UserActionSheet";
import { PeopleContext } from "./PeopleContext";
import { useBulkQuota } from "./bulkQuotaContext";
import {userListSummary} from "./userList.helpers";
import { IconMore } from "../ui/icons";
import type { SwipeSide } from "./useUserRowGestures";
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
import "./userList.css";

const FILTER_ORDER: readonly UserFilter[] = ["all", "online", "issues"];
const PHONE_LIST_QUERY = "(max-width: 699px)";

export function PeopleList() {
  const s = useStrings();
  const topic = useUsersTopic();
  const access = useContext(PeopleContext);
  const savedView = access.listView;
  const bulkQuota = useBulkQuota();
  const connection = useConnectionState();
  const now = useNow();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollOffsetRef=useRef(savedView.scrollOffset);
  const restoringLayoutRef=useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const phoneListLayout = usePhoneListLayout();
  const [search, setSearch] = useState(savedView.search);
  const delayedSearch = useDebouncedValue(search);
  const debouncedSearch = search.trim() === "" ? "" : delayedSearch;
  const [filter, setFilter] = useState<UserFilter>(savedView.filter);
  const [sort, setSort] = useState(() => getStoredUserSort());
  const [actionUser, setActionUser] = useState<UsersTopicUser | null>(null);
  const [actionIntent,setActionIntent] = useState<ActionSheetIntent>("menu");
  const [actionAnchor,setActionAnchor]=useState<DOMRect|undefined>();
  const [swiped, setSwiped] = useState<{username:string;side:SwipeSide}|null>(null);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [gestureHintVisible, setGestureHintVisible] = useState(true);
  const [searchOpen,setSearchOpen] = useState(savedView.search.length>0);
  const [width,setWidth] = useState(0);
  const layoutRef=useRef<{columns:number;rowHeight:number}|null>(null);
  const table=width>=960,columns=table||width<640?1:2,rowHeight=table?98:260;
  const activePreset = sortPresetOf(sort);
  const sortAscending = sort.direction === "asc";
  const sortChipLabel = sortLabelFor(s, activePreset, true, sortAscending);

  function updateSort(next: typeof sort) {
    setSort(next);
    setStoredUserSort(next);
  }

  const webUsernames = useMemo(() => new Set(access.profiles.keys()), [access.profiles]);
  const filterOrder = access.profiles.size ? [...FILTER_ORDER, "web" as const] : FILTER_ORDER;
  const entries = useMemo<UserFilterInput<UsersTopicUser>[]>(
    () => topic.users.map((user) => ({
      user,
      status: computeUserStatus(user, getUserQuota(user, findQuotaEntry(topic.quota, user.username)), now),
      webAccess: webUsernames.has(user.username),
    })),
    [topic.users, topic.quota, now, webUsernames],
  );
  const counts = useMemo(() => countUserFilters(entries), [entries]);
  const summary=useMemo(()=>userListSummary(topic.users,topic.quota),[topic.users,topic.quota]);
  const visibleUsers = useMemo(() => {
    const kept = entries.filter((entry) => matchesUserFilter(entry, filter)).map((entry) => entry.user);
    return sortUsers(filterUsersByQuery(kept, debouncedSearch), sort);
  }, [entries, filter, debouncedSearch, sort]);
  const isNarrowed = debouncedSearch.trim().length > 0 || filter !== "all";
  // TanStack Virtual exposes an imperative object by design; React Compiler
  // must leave this component un-memoized rather than freeze its measurements.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: Math.ceil(visibleUsers.length/columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
    initialOffset: savedView.scrollOffset,
    getItemKey: (index) => visibleUsers[index*columns]?.username ?? index,
  });
  useLayoutEffect(()=>{
    const container=containerRef.current;if(!container)return;
    const observer=new ResizeObserver(([entry])=>{if(entry)setWidth(entry.contentRect.width);});
    observer.observe(container);return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{
    if(width===0)return;
    const previous=layoutRef.current;
    layoutRef.current={columns,rowHeight};
    if(previous?.columns===columns&&previous.rowHeight===rowHeight)return;
    const offset=scrollOffsetRef.current;
    const remainder=previous?offset%previous.rowHeight:0;
    const inGap=previous!==null&&remainder>=previous.rowHeight-10;
    const index=previous?Math.min(visibleUsers.length-1,(Math.floor(offset/previous.rowHeight)+(inGap?1:0))*previous.columns):0;
    const fraction=previous&&!inGap?remainder/(previous.rowHeight-10):0;
    restoringLayoutRef.current=previous!==null;
    virtualizer.measure();
    if(!previous||index<0||savedView.returnUsername){restoringLayoutRef.current=false;return;}
    // Keep the same topmost person when a table becomes a grouped card grid.
    // Apply after the measured canvas commits, otherwise the browser can
    // clamp a near-bottom offset against the previous layout's shorter height.
    const frame=requestAnimationFrame(()=>{
      virtualizer.scrollToOffset(Math.floor(index/columns)*rowHeight+fraction*(rowHeight-10));
      scrollOffsetRef.current=scrollRef.current?.scrollTop??0;
      savedView.scrollOffset=scrollOffsetRef.current;
      restoringLayoutRef.current=false;
    });
    return()=>{cancelAnimationFrame(frame);restoringLayoutRef.current=false;};
  },[columns,rowHeight,virtualizer,width,visibleUsers.length,savedView]);
  useEffect(()=>{setSwiped(null);},[phoneListLayout]);
  useEffect(()=>{if(!swiped)return;const close=(event:KeyboardEvent)=>{if(event.key!=="Escape"||document.querySelector('[role="dialog"]'))return;setSwiped(null);const row=[...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-user]')??[])].find(row=>row.dataset["user"]===swiped.username);row?.querySelector<HTMLButtonElement>('button.user-identity')?.focus();};document.addEventListener("keydown",close);return()=>document.removeEventListener("keydown",close);},[swiped]);

  useEffect(() => {
    const username = savedView.returnUsername;
    if (!username || topic.isPending || width===0 || visibleUsers.length === 0) return;
    const index = visibleUsers.findIndex((user) => user.username === username);
    if (index < 0) {savedView.returnUsername=null;return;}

    // After a mobile detail route unmounts the list, return to the person the
    // operator opened. Anchoring to identity is stable even when live activity
    // changes the sort order while the detail screen is open.
    const frame = window.requestAnimationFrame(() => {
      savedView.returnUsername = null;
      virtualizer.scrollToIndex(Math.floor(index/columns), { align: "center" });
      savedView.scrollOffset = scrollRef.current?.scrollTop ?? savedView.scrollOffset;
      scrollOffsetRef.current=savedView.scrollOffset;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [topic.isPending, visibleUsers, virtualizer, savedView,columns,width]);

  useEffect(()=>{if(searchOpen)searchRef.current?.focus();},[searchOpen]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  function setSearchValue(value: string) {
    setSwiped(null);
    savedView.search = value;
    savedView.returnUsername = null;
    savedView.scrollOffset = 0;
    scrollOffsetRef.current=0;
    setSearch(value);
    virtualizer.scrollToOffset(0);
  }

  function setFilterValue(value: UserFilter) {
    setSwiped(null);
    savedView.filter = value;
    savedView.scrollOffset = 0;
    scrollOffsetRef.current=0;
    setFilter(value);
    virtualizer.scrollToOffset(0);
  }

  function openPerson(user: UsersTopicUser) {
    setSwiped(null);
    savedView.scrollOffset = scrollRef.current?.scrollTop ?? 0;
    savedView.returnUsername = user.username;
    navigate({ to: "/people/$username", params: { username: user.username } });
  }

  function openActions(user:UsersTopicUser,intent:ActionSheetIntent="menu",anchor?:DOMRect) {
    setSwiped(null);setActionIntent(intent);setActionUser(user);setActionAnchor(anchor);
  }
  const create = ()=>void navigate({to:"/people",search:{create:true}});
  const edit = (user:UsersTopicUser)=>void navigate({to:"/people/$username",params:{username:user.username},search:{tab:"settings"}});

  return (
    <div ref={containerRef} className="users-workspace users-reference-list flex min-h-0 flex-1 flex-col p-4" data-layout={table?"table":"cards"}>
      <PageHeader title={s.people.title} actions={
        <div className="flex shrink-0 gap-2"><Button className="user-create-desktop" aria-label={s.people.create} disabled={access.readOnly||topic.stale} onClick={create}><IconPlus className="h-4 w-4" /><span>{s.people.create}</span></Button><button type="button" className="user-menu-trigger" aria-label={s.people.bulkQuota.menu} onClick={e=>bulkQuota.openMenu(e.currentTarget.getBoundingClientRect())}><IconMore/></button></div>
      } />

      <div className="user-list-summary" aria-label={s.people.list.summary}>
        <span><i/><strong>{topic.isPending?"—":formatNumber(s,counts.all)}</strong><small>{s.people.list.users}</small></span>
        <span><i className="green"/><strong>{topic.isPending?"—":formatNumber(s,counts.online)}</strong><small>{s.people.online}</small><em>{topic.isPending?"—":formatNumber(s,summary.connections)} {s.people.list.connectionsShort}</em></span>
        <span title={s.people.list.monthHint}><i className="purple"/><strong>{topic.isPending||summary.monthBytes===null?"—":formatBytes(summary.monthBytes,s)}</strong><small>{s.people.list.month}</small></span>
        <span title={s.people.list.nearQuotaHint}><i className="amber"/><strong>{topic.isPending?"—":formatNumber(s,summary.nearQuota)}</strong><small>{s.people.list.nearQuota}</small></span>
      </div>
      {!topic.isPending&&access.readOnly&&<p className="user-list-readonly">{s.people.workspace.readOnly}</p>}

      <div className="flex min-h-0 flex-1 gap-3">
        <section className="people-list-pane flex min-w-0 flex-1 flex-col">
          <div className="people-toolbar">
            <div className={`user-search-filters ${searchOpen?"search-open":""}`}>
            {(!phoneListLayout||searchOpen)&&
            <div className="people-search-control">
              <IconSearch className="h-4 w-4 shrink-0" />
              <input ref={searchRef} value={search} onChange={(event) => setSearchValue(event.target.value)} placeholder={s.people.searchPlaceholder} aria-label={s.people.searchPlaceholder} autoCapitalize="off" autoCorrect="off" />
              {search ? <button type="button" className="people-search-clear" aria-label={s.people.clearSearch} onClick={()=>{setSearchValue("");searchRef.current?.focus();}}><IconClose className="h-4 w-4"/></button> : !phoneListLayout&&<kbd>⌘ K</kbd>}
              {phoneListLayout&&<button type="button" className="people-search-clear" aria-label={s.people.list.closeSearch} onClick={()=>{setSearchValue("");setSearchOpen(false);}}><IconClose className="h-4 w-4"/></button>}
            </div>}
            <div className="people-filter-group no-scrollbar" role="tablist" aria-label={s.people.filterLabel}>
              {filterOrder.filter(key=>!phoneListLayout||key!=="web").map((key) => <button key={key} type="button" role="tab" className="people-filter-button" aria-selected={filter === key} onClick={() => setFilterValue(key)}><span>{s.people.filter[key]}</span><b>{formatNumber(s,counts[key])}</b></button>)}
            </div>
            {phoneListLayout&&!searchOpen&&<button type="button" className="user-search-open" aria-label={s.people.list.openSearch} onClick={()=>setSearchOpen(true)}><IconSearch className="h-4 w-4"/></button>}
            </div>
            {phoneListLayout?<button type="button" className="user-create-phone" aria-label={s.people.create} disabled={access.readOnly||topic.stale} onClick={create}><IconPlus/></button>:<button type="button" className="people-sort-button" aria-label={sortChipLabel} onClick={() => setSortSheetOpen(true)}><IconSort className="h-4 w-4" /><span>{s.people.sortPreset[activePreset]}</span><SortArrow ascending={sortAscending} /></button>}
          </div>

          {phoneListLayout&&<div className="user-mobile-tools">{gestureHintVisible?<p>{s.people.workspace.swipeHint}</p>:<span/>}{access.profiles.size>0&&<button type="button" aria-pressed={filter==="web"} onClick={()=>setFilterValue(filter==="web"?"all":"web")}>WEB {counts.web}</button>}<button type="button" className="people-sort-button" aria-label={sortChipLabel} onClick={()=>setSortSheetOpen(true)}>{s.people.sortPreset[activePreset]}<SortArrow ascending={sortAscending}/></button>{gestureHintVisible&&<button type="button" aria-label={s.common.close} onClick={()=>setGestureHintVisible(false)}><IconClose className="h-3 w-3"/></button>}</div>}

          {table&&<div className="user-table-head" aria-hidden="true"><span>{s.people.tableUser}</span><span>{s.people.connections}</span><span>{s.people.workspace.totalTraffic} / {s.people.form.quota}</span><span>{s.people.form.expiry}</span><span>{s.people.workspace.quickLinks} / {s.people.actions.menu}</span></div>}

          <div ref={scrollRef} className="people-list-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain" onScroll={(event) => {if(!restoringLayoutRef.current){scrollOffsetRef.current=event.currentTarget.scrollTop;savedView.scrollOffset=scrollOffsetRef.current;}}}>
            <AsyncState
              isPending={topic.isPending}
              isError={topic.isError}
              errorCode={topic.errorCode ?? undefined}
              data={visibleUsers}
              isEmpty={(data) => data.length === 0}
              emptyTitle={isNarrowed ? s.common.empty : s.people.emptyTitle}
              emptyDescription={isNarrowed ? undefined : s.people.emptyDescription}
              emptyAction={isNarrowed ? undefined : <Button disabled={access.readOnly} onClick={create}>{s.people.create}</Button>}
              stale={topic.stale || connection.stale}
              onRetry={connection.retry}
              skeleton={<PeopleListSkeleton />}
            >
              {(users) => (
                <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                  {virtualizer.getVirtualItems().map((item) => {
                    return (
                      <div key={item.key} data-index={item.index} className="user-virtual-row" style={{ transform: `translateY(${item.start}px)`,height:rowHeight,gridTemplateColumns:`repeat(${columns},minmax(0,1fr))` }}>
                        {users.slice(item.index*columns,(item.index+1)*columns).map(user=>
                        <UserCard
                          key={user.username}
                          user={user}
                          quotaEntry={findQuotaEntry(topic.quota, user.username)}
                          now={now}
                          gesturesEnabled={phoneListLayout}
                          swipeSide={swiped?.username===user.username?swiped.side:null}
                          canResetQuota={access.canResetQuota&&!topic.stale&&!bulkQuota.running}
                          canToggle={access.canToggle&&!topic.stale}
                          onOpen={() => openPerson(user)}
                          onActions={anchor => openActions(user,"menu",anchor)}
                          onResetQuota={()=>openActions(user,"reset-quota")}
                          onToggle={()=>openActions(user,"toggle-enabled")}
                          onSwipeChange={side=>setSwiped(prev=>side?{username:user.username,side}:prev?.username===user.username?null:prev)}
                        />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </AsyncState>
          </div>

          <footer className="user-list-footer">
            <span>{isNarrowed ? `${visibleUsers.length} / ${counts.all}` : pluralTemplate(s, counts.all, s.people.recordsCount)}<span className="hidden sm:inline"> · {s.people.searchWholeSet}</span></span>
          </footer>
        </section>

      </div>

      <UserActionSheet key={`${actionUser?.username}:${actionIntent}`} open={actionUser !== null} user={actionUser} anchor={actionAnchor} intent={actionIntent} readOnly={access.readOnly||topic.stale} onClose={() => setActionUser(null)} onEdit={edit} onOpenPerson={openPerson} onOpenAccess={user=>void navigate({to:"/people/$username",params:{username:user.username},search:{tab:"access"}})} />
      <Sheet open={sortSheetOpen} onClose={() => setSortSheetOpen(false)} title={s.people.sortLabel}>
        <CardList>
          {SORT_PRESET_ORDER.map((preset) => {
            const active = activePreset === preset;
            const ascending = active && sortAscending;
            return <CardRow key={preset}><button type="button" className="flex min-h-[44px] flex-1 items-center gap-2 text-left text-row text-text" aria-label={sortLabelFor(s, preset, active, ascending)} onClick={() => { updateSort(nextSortState(sort, preset)); setSortSheetOpen(false); }}><span className="flex-1">{s.people.sortPreset[preset]}</span>{active && <span className="flex items-center gap-1 text-meta text-text-muted">{ascending ? s.people.sortAscending : s.people.sortDescending}<SortArrow ascending={ascending} /></span>}</button></CardRow>;
          })}
        </CardList>
      </Sheet>
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
