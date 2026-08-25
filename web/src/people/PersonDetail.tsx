import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ru } from "../i18n/ru";
import { AsyncState } from "../components/AsyncState";
import { Avatar } from "../ui/Avatar";
import { IconButton } from "../ui/IconButton";
import { IconChevronLeft, IconMore } from "../ui/icons";
import { StatCard } from "../ui/StatCard";
import { useDisplayMode, visibleFor, type DisplayMode } from "../display-mode";
import { useConnectionState } from "../realtime";
import { useUsersTopic, findQuotaEntry } from "./useUsersTopic";
import { useNow } from "./useNow";
import { UserStatusPill } from "./UserStatusPill";
import { UserActionSheet } from "./UserActionSheet";
import { UserFormSheet } from "./UserFormSheet";
import { SublinkPanel } from "./SublinkPanel";
import {
  ExpiryLine,
  IpCards,
  PersonExtras,
  PersonLinks,
  PersonQuotaCard,
  SectionLabel,
} from "./PersonSections";
import { computeUserStatus, getUserQuota, isOnline } from "./users.helpers";
import { personAvatarTone, personHasExtras } from "./personMeta.helpers";
import type { UsersTopicUser } from "../realtime/topics";

// PersonDetail — /people/$username (06-ui.md §Люди): live metrics from the
// "users" SSE topic, quota bar, IP cards, per-field connection links, and
// sub-link management — everything the action sheet also offers, plus the
// full data the list only summarizes. This is the phone layout; on `lg:`
// the same URL renders the list with the Инспектор panel instead
// (routes/_authed/people/route.tsx), over the same components.
export function PersonDetail({ username }: { username: string }) {
  const topic = useUsersTopic();
  const connection = useConnectionState();
  const { mode } = useDisplayMode();
  const now = useNow();
  const navigate = useNavigate();

  const [actionsOpen, setActionsOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3">
      <Link
        to="/people"
        className="mb-3 inline-flex min-h-11 items-center text-meta font-medium text-text-muted hover:text-text"
      >
        <IconChevronLeft className="mr-1 h-4 w-4" />
        {ru.nav.people}
      </Link>

      {/* data is the whole topic list, not the single user: AsyncState's
          `data === undefined` check means "topic hasn't produced a
          snapshot yet" (isPending's job) — using that same sentinel for
          "this specific user isn't in an already-loaded list" would never
          fire, since AsyncState returns null for undefined data before
          isEmpty ever runs. Checking emptiness against the filtered list
          instead makes "not found" a real, distinct condition. */}
      <AsyncState
        isPending={topic.isPending}
        isError={topic.isError}
        errorCode={topic.errorCode ?? undefined}
        data={topic.users}
        isEmpty={(users) => !users.some((u) => u.username === username)}
        emptyTitle={ru.people.notFoundTitle}
        stale={topic.stale || connection.stale}
        onRetry={connection.retry}
      >
        {(users) => {
          const u = users.find((candidate) => candidate.username === username)!;
          return (
            <PersonDetailBody
              user={u}
              quotaEntry={findQuotaEntry(topic.quota, u.username)}
              mode={mode}
              now={now}
              onOpenActions={() => setActionsOpen(true)}
              actionsSheet={
                <UserActionSheet
                  open={actionsOpen}
                  user={u}
                  onClose={() => setActionsOpen(false)}
                  onEdit={() => setFormOpen(true)}
                  onDeleted={() => navigate({ to: "/people" })}
                />
              }
              formSheet={<UserFormSheet open={formOpen} mode="edit" user={u} onClose={() => setFormOpen(false)} />}
            />
          );
        }}
      </AsyncState>
    </div>
  );
}

function PersonDetailBody({
  user,
  quotaEntry,
  mode,
  now,
  onOpenActions,
  actionsSheet,
  formSheet,
}: {
  user: UsersTopicUser;
  quotaEntry: ReturnType<typeof findQuotaEntry>;
  mode: DisplayMode;
  now: number;
  onOpenActions: () => void;
  actionsSheet: ReactNode;
  formSheet: ReactNode;
}) {
  const quota = getUserQuota(user, quotaEntry);
  const status = computeUserStatus(user, quota, now);
  const activeIps = user.active_unique_ips_list ?? [];
  const recentIps = user.recent_unique_ips_list ?? [];
  const hasExtras = personHasExtras(user);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-3">
        <Avatar
          name={user.username}
          tone={personAvatarTone(user, status)}
          online={isOnline(user)}
          ringOn="bg"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-text">{user.username}</h1>
          <UserStatusPill status={status} className="mt-1" />
        </div>
        <IconButton aria-label={ru.people.actions.menu} onClick={onOpenActions}>
          <IconMore />
        </IconButton>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <StatCard label={ru.people.connections} value={user.current_connections} />
        <StatCard label={ru.people.activeIps} value={user.active_unique_ips} />
      </section>

      <PersonQuotaCard quota={quota} />

      <section className="flex flex-col gap-1">
        <SectionLabel>{ru.people.form.expiry}</SectionLabel>
        <ExpiryLine expirationRfc3339={user.expiration_rfc3339} now={now} />
      </section>

      {visibleFor("basic", mode) && (
        <section className="flex flex-col gap-2">
          <SectionLabel>
            {ru.people.detail.activeIpsTitle} · {activeIps.length}
          </SectionLabel>
          <IpCards ips={activeIps} />
        </section>
      )}

      {visibleFor("extended", mode) && (
        <section className="flex flex-col gap-2">
          <SectionLabel>{ru.people.detail.recentIpsTitle}</SectionLabel>
          <IpCards ips={recentIps} />
        </section>
      )}

      {visibleFor("extended", mode) && hasExtras && (
        <section className="flex flex-col gap-2">
          <SectionLabel>{ru.people.form.advanced}</SectionLabel>
          <PersonExtras user={user} />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <SectionLabel>{ru.people.share.title}</SectionLabel>
        <SublinkPanel username={user.username} />
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel>{ru.people.detail.linksTitle}</SectionLabel>
        <PersonLinks links={user.links} />
      </section>

      {actionsSheet}
      {formSheet}
    </div>
  );
}
