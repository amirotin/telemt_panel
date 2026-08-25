import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncState } from "../components/AsyncState";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Input } from "../ui/Input";
import { IconButton } from "../ui/IconButton";
import { IconArrowDown, IconArrowUp, IconPlus, IconSort } from "../ui/icons";
import { CardList, CardRow } from "../ui/Card";
import { Sheet } from "../ui/Sheet";
import { pluralTemplate, useStrings, type Dict } from "../i18n";
import { useDisplayMode } from "../display-mode";
import { useConnectionState } from "../realtime";
import { useUsersTopic, findQuotaEntry } from "./useUsersTopic";
import { useDebouncedValue } from "./useDebouncedValue";
import { useNow } from "./useNow";
import { UserCard } from "./UserCard";
import { UserActionSheet } from "./UserActionSheet";
import { UserFormSheet } from "./UserFormSheet";
import { PersonInspector } from "./PersonInspector";
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

export interface PeopleListProps {
  /**
   * The person the `lg:` Инспектор is showing, taken from the
   * /people/$username route (routes/_authed/people/route.tsx). null on
   * mobile, where the same URL renders the full-screen detail instead.
   */
  selectedUsername?: string | null;
}

// PeopleList — the /people landing screen (06-ui.md §Люди): search, filter
// segments and sort chips over the live "users" SSE topic, one row per
// person at every width, and — from `lg:` up — the Инспектор panel showing
// the selected person beside the list instead of navigating away from it.
export function PeopleList({ selectedUsername = null }: PeopleListProps) {
  const s = useStrings();
  const topic = useUsersTopic();
  const connection = useConnectionState();
  const { mode } = useDisplayMode();
  const now = useNow();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [filter, setFilter] = useState<UserFilter>("all");
  const [sort, setSort] = useState(() => getStoredUserSort());
  const [actionUser, setActionUser] = useState<UsersTopicUser | null>(null);
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);

  const activePreset = sortPresetOf(sort);
  const sortAscending = sort.direction === "asc";
  const sortChipLabel = sortLabelFor(s, activePreset, true, sortAscending);

  function updateSort(next: typeof sort) {
    setSort(next);
    setStoredUserSort(next);
  }

  // Statuses are computed once per snapshot and reused by both the counts
  // and the filter — computeUserStatus is the single status source
  // (users.helpers.ts) and running it twice per user per render on a
  // thousand-row list would be pure waste.
  const entries = useMemo<UserFilterInput<UsersTopicUser>[]>(
    () =>
      topic.users.map((user) => ({
        user,
        status: computeUserStatus(user, getUserQuota(user, findQuotaEntry(topic.quota, user.username)), now),
      })),
    [topic.users, topic.quota, now],
  );

  const counts = useMemo(() => countUserFilters(entries), [entries]);

  const visibleUsers = useMemo(() => {
    const kept = entries.filter((entry) => matchesUserFilter(entry, filter)).map((e) => e.user);
    return sortUsers(filterUsersByQuery(kept, debouncedSearch), sort);
  }, [entries, filter, debouncedSearch, sort]);

  const isNarrowed = debouncedSearch.trim().length > 0 || filter !== "all";

  function openPerson(user: UsersTopicUser) {
    navigate({ to: "/people/$username", params: { username: user.username } });
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border">
          <div className="flex items-center gap-2.5 px-4 pb-2 pt-3">
            <h1 className="text-title font-extrabold tracking-tight text-text">{s.people.title}</h1>
            <span className="font-mono text-micro tabular-nums text-text-faint">{counts.all}</span>
            {/* Wrapped rather than given `hidden lg:inline-flex` directly:
                IconButton's own base class already sets `inline-flex`, and
                two same-specificity display utilities would be decided by
                CSS source order, not by the one written last here. */}
            <span className="ml-auto hidden lg:block">
              <IconButton
                variant="accent"
                aria-label={s.people.create}
                className="h-[42px] w-[42px]"
                onClick={() => setFormTarget({ mode: "create" })}
              >
                <IconPlus />
              </IconButton>
            </span>
          </div>

          {/* Below `sm:` the sort control rides in the search row rather
              than the chip strip below it: three filter chips with their
              counts already fill 360px, so a fourth chip only ever sat
              half-scrolled off the right edge — nothing on the first screen
              said the list could be sorted at all (design review N2). Here
              it is always visible and costs no extra row. */}
          <div className="flex items-center gap-2 px-4 pb-2">
            <div className="min-w-0 flex-1">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={pluralTemplate(s, counts.all, s.people.searchAmong)}
                aria-label={s.people.searchPlaceholder}
                autoCapitalize="off"
              />
            </div>
            <Chip
              className="h-[44px] shrink-0 sm:hidden"
              icon={<IconSort className="h-3.5 w-3.5" />}
              aria-label={sortChipLabel}
              onClick={() => setSortSheetOpen(true)}
            >
              {s.people.sortPreset[activePreset]}
              <SortArrow ascending={sortAscending} />
            </Chip>
          </div>

          <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4 pb-2.5">
            {FILTER_ORDER.map((key) => (
              <Chip
                key={key}
                active={filter === key}
                count={counts[key]}
                onClick={() => setFilter(key)}
              >
                {s.people.filter[key]}
              </Chip>
            ))}
            {/* Below `sm:` the three filter chips plus three sort chips do
                not fit 360px, and the sort half scrolled off-screen at rest
                — nothing on the first screen said the list could be sorted
                at all. There, one chip naming the current sort stands in
                and opens the same three choices in a Sheet; from `sm:` up
                the original strip is unchanged. */}
            {/* Tapping the active sort chip flips its direction — the
                arrow is both the current-direction readout and the
                affordance for that, so ascending/descending stay reachable
                for every field without a separate control. */}
            <span className="ml-auto hidden items-center gap-1.5 sm:flex">
              {SORT_PRESET_ORDER.map((preset) => {
                const active = activePreset === preset;
                const ascending = active && sort.direction === "asc";
                return (
                  <Chip
                    key={preset}
                    active={active}
                    aria-label={sortLabelFor(s, preset, active, ascending)}
                    onClick={() => updateSort(nextSortState(sort, preset))}
                  >
                    {s.people.sortPreset[preset]}
                    {active && <SortArrow ascending={ascending} />}
                  </Chip>
                );
              })}
            </span>
          </div>
        </div>

        {/* The gutter lives here so the empty/error/skeleton states sit
            inside it, while the rows bleed back out to the full width the
            prototype's list uses. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3 lg:pb-4">
          <AsyncState
            isPending={topic.isPending}
            isError={topic.isError}
            errorCode={topic.errorCode ?? undefined}
            data={visibleUsers}
            isEmpty={(d) => d.length === 0}
            emptyTitle={isNarrowed ? s.common.empty : s.people.emptyTitle}
            emptyDescription={isNarrowed ? undefined : s.people.emptyDescription}
            emptyAction={
              isNarrowed ? undefined : (
                <Button onClick={() => setFormTarget({ mode: "create" })}>{s.people.create}</Button>
              )
            }
            stale={topic.stale || connection.stale}
            onRetry={connection.retry}
            skeleton={<PeopleListSkeleton />}
          >
            {(users) => (
              <div className="-mx-4 -mt-3 flex flex-col">
                {users.map((user) => (
                  <UserCard
                    key={user.username}
                    user={user}
                    quotaEntry={findQuotaEntry(topic.quota, user.username)}
                    mode={mode}
                    now={now}
                    selected={user.username === selectedUsername}
                    onOpen={() => openPerson(user)}
                    onActions={() => setActionUser(user)}
                  />
                ))}
              </div>
            )}
          </AsyncState>
        </div>

        <span className="fixed bottom-[84px] right-4 z-30 lg:hidden">
          <IconButton
            variant="accent"
            aria-label={s.people.create}
            className="h-14 w-14 text-[22px]"
            onClick={() => setFormTarget({ mode: "create" })}
          >
            <IconPlus />
          </IconButton>
        </span>
      </div>

      {selectedUsername && (
        <PersonInspector
          username={selectedUsername}
          onClose={() => navigate({ to: "/people" })}
          onEdit={(user) => setFormTarget({ mode: "edit", user })}
        />
      )}

      <UserActionSheet
        open={actionUser !== null}
        user={actionUser}
        onClose={() => setActionUser(null)}
        onEdit={(user) => setFormTarget({ mode: "edit", user })}
      />

      <Sheet
        open={sortSheetOpen}
        onClose={() => setSortSheetOpen(false)}
        title={s.people.sortLabel}
      >
        <CardList>
          {SORT_PRESET_ORDER.map((preset) => {
            const active = activePreset === preset;
            const ascending = active && sortAscending;
            return (
              <CardRow key={preset}>
                <button
                  type="button"
                  className="flex min-h-[44px] flex-1 items-center gap-2 text-left text-row text-text"
                  aria-label={sortLabelFor(s, preset, active, ascending)}
                  onClick={() => {
                    updateSort(nextSortState(sort, preset));
                    setSortSheetOpen(false);
                  }}
                >
                  <span className="flex-1">{s.people.sortPreset[preset]}</span>
                  {active && (
                    <span className="flex items-center gap-1 text-meta text-text-muted">
                      {ascending ? s.people.sortAscending : s.people.sortDescending}
                      <SortArrow ascending={ascending} />
                    </span>
                  )}
                </button>
              </CardRow>
            );
          })}
        </CardList>
      </Sheet>

      <UserFormSheet
        open={formTarget !== null}
        mode={formTarget?.mode ?? "create"}
        user={formTarget?.mode === "edit" ? formTarget.user : null}
        onClose={() => setFormTarget(null)}
      />
    </div>
  );
}

// sortLabelFor is the accessible name both sort controls announce: the
// visible cue for direction is the ↑/↓ glyph, which carries no text of its
// own, so it has to be spelled out here.
function sortLabelFor(s: Dict, preset: UserSortPreset, active: boolean, ascending: boolean): string {
  const direction = active ? `, ${ascending ? s.people.sortAscending : s.people.sortDescending}` : "";
  return `${s.people.sortLabel}: ${s.people.sortPreset[preset]}${direction}`;
}

function SortArrow({ ascending }: { ascending: boolean }) {
  return ascending ? (
    <IconArrowUp className="h-3 w-3" />
  ) : (
    <IconArrowDown className="h-3 w-3" />
  );
}

function PeopleListSkeleton() {
  return (
    <div className="-mx-4 -mt-3 flex flex-col">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 px-4">
          <div className="h-[52px] w-[52px] shrink-0 animate-pulse rounded-full bg-surface-2" />
          <div className="flex-1 border-b border-border py-3">
            <div className="h-3.5 w-28 animate-pulse rounded bg-surface-2" />
            <div className="mt-2 h-3 w-44 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}
