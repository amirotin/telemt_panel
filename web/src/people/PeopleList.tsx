import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncState } from "../components/AsyncState";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Input } from "../ui/Input";
import { IconButton } from "../ui/IconButton";
import { IconPlus, IconSort } from "../ui/icons";
import { ru } from "../i18n/ru";
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
  sortPresetOf,
  sortUsers,
  SORT_PRESETS,
  SORT_PRESET_ORDER,
  type UserFilter,
  type UserFilterInput,
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

  const activePreset = sortPresetOf(sort);

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
            <h1 className="text-title font-extrabold tracking-tight text-text">{ru.people.title}</h1>
            <span className="font-mono text-micro tabular-nums text-text-faint">{counts.all}</span>
            {/* Wrapped rather than given `hidden lg:inline-flex` directly:
                IconButton's own base class already sets `inline-flex`, and
                two same-specificity display utilities would be decided by
                CSS source order, not by the one written last here. */}
            <span className="ml-auto hidden lg:block">
              <IconButton
                variant="accent"
                aria-label={ru.people.create}
                className="h-[42px] w-[42px]"
                onClick={() => setFormTarget({ mode: "create" })}
              >
                <IconPlus />
              </IconButton>
            </span>
          </div>

          <div className="px-4 pb-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={ru.people.searchAmongTemplate.replace("{n}", String(counts.all))}
              aria-label={ru.people.searchPlaceholder}
              autoCapitalize="off"
            />
          </div>

          <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4 pb-2.5">
            {FILTER_ORDER.map((key) => (
              <Chip
                key={key}
                active={filter === key}
                count={counts[key]}
                onClick={() => setFilter(key)}
              >
                {ru.people.filter[key]}
              </Chip>
            ))}
            <span className="ml-auto flex items-center gap-1.5">
              {SORT_PRESET_ORDER.map((preset) => (
                <Chip
                  key={preset}
                  active={activePreset === preset}
                  icon={preset === "activity" ? <IconSort className="h-3 w-3" /> : undefined}
                  aria-label={`${ru.people.sortLabel}: ${ru.people.sortPreset[preset]}`}
                  onClick={() => updateSort(SORT_PRESETS[preset])}
                >
                  {ru.people.sortPreset[preset]}
                </Chip>
              ))}
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
            emptyTitle={isNarrowed ? ru.common.empty : ru.people.emptyTitle}
            emptyDescription={isNarrowed ? undefined : ru.people.emptyDescription}
            emptyAction={
              isNarrowed ? undefined : (
                <Button onClick={() => setFormTarget({ mode: "create" })}>{ru.people.create}</Button>
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
            aria-label={ru.people.create}
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

      <UserFormSheet
        open={formTarget !== null}
        mode={formTarget?.mode ?? "create"}
        user={formTarget?.mode === "edit" ? formTarget.user : null}
        onClose={() => setFormTarget(null)}
      />
    </div>
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
