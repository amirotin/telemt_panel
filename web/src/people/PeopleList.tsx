import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncState } from "../components/AsyncState";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { IconButton } from "../ui/IconButton";
import { ru } from "../i18n/ru";
import { useDisplayMode } from "../display-mode";
import { useConnectionState } from "../realtime";
import { useUsersTopic, findQuotaEntry } from "./useUsersTopic";
import { useDebouncedValue } from "./useDebouncedValue";
import { useNow } from "./useNow";
import { UserCard } from "./UserCard";
import { UserTable } from "./UserTable";
import { UserActionSheet } from "./UserActionSheet";
import { UserFormSheet } from "./UserFormSheet";
import {
  filterUsersByQuery,
  getStoredUserSort,
  setStoredUserSort,
  sortUsers,
  type UserSortField,
} from "./users.helpers";
import type { UsersTopicUser } from "../realtime/topics";

type FormTarget = { mode: "create" } | { mode: "edit"; user: UsersTopicUser };

// PeopleList — the /people landing screen (06-ui.md §Люди): search + sort
// over the live "users" SSE topic, cards on mobile / table on `lg:`, the
// action sheet and create/edit form shared with the detail screen.
export function PeopleList() {
  const topic = useUsersTopic();
  const connection = useConnectionState();
  const { mode } = useDisplayMode();
  const now = useNow();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [sort, setSort] = useState(() => getStoredUserSort());
  const [actionUser, setActionUser] = useState<UsersTopicUser | null>(null);
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);

  function updateSort(next: typeof sort) {
    setSort(next);
    setStoredUserSort(next);
  }

  const visibleUsers = useMemo(
    () => sortUsers(filterUsersByQuery(topic.users, debouncedSearch), sort),
    [topic.users, debouncedSearch, sort],
  );

  const isSearching = debouncedSearch.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-text">{ru.people.title}</h1>
        <Button onClick={() => setFormTarget({ mode: "create" })}>{ru.people.create}</Button>
      </header>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={ru.people.searchPlaceholder}
          autoCapitalize="off"
          className="flex-1"
        />
        <div className="flex gap-2">
          <Select
            aria-label={ru.people.sortLabel}
            value={sort.field}
            onChange={(e) => updateSort({ ...sort, field: e.target.value as UserSortField })}
          >
            <option value="name">{ru.people.sortField.name}</option>
            <option value="traffic">{ru.people.sortField.traffic}</option>
            <option value="connections">{ru.people.sortField.connections}</option>
          </Select>
          <IconButton
            aria-label={ru.people.sortLabel}
            onClick={() => updateSort({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })}
          >
            {sort.direction === "asc" ? "↑" : "↓"}
          </IconButton>
        </div>
      </div>

      <AsyncState
        isPending={topic.isPending}
        isError={topic.isError}
        errorCode={topic.errorCode ?? undefined}
        data={visibleUsers}
        isEmpty={(d) => d.length === 0}
        emptyTitle={isSearching ? ru.common.empty : ru.people.emptyTitle}
        emptyDescription={isSearching ? undefined : ru.people.emptyDescription}
        emptyAction={
          isSearching ? undefined : (
            <Button onClick={() => setFormTarget({ mode: "create" })}>{ru.people.create}</Button>
          )
        }
        stale={topic.stale || connection.stale}
        onRetry={connection.retry}
      >
        {(users) => (
          <>
            <div className="flex flex-col gap-3 lg:hidden">
              {users.map((user) => (
                <UserCard
                  key={user.username}
                  user={user}
                  quotaEntry={findQuotaEntry(topic.quota, user.username)}
                  mode={mode}
                  now={now}
                  onOpen={() => navigate({ to: "/people/$username", params: { username: user.username } })}
                  onActions={() => setActionUser(user)}
                />
              ))}
            </div>
            <div className="hidden lg:block">
              <UserTable
                users={users}
                quota={topic.quota}
                mode={mode}
                now={now}
                onOpen={(user) => navigate({ to: "/people/$username", params: { username: user.username } })}
                onActions={(user) => setActionUser(user)}
              />
            </div>
          </>
        )}
      </AsyncState>

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
