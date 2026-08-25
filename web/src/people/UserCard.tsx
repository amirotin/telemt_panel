import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { IconButton } from "../ui/IconButton";
import { QuotaBar } from "../ui/QuotaBar";
import { UserStatusPill } from "./UserStatusPill";
import { useLongPress } from "./useLongPress";
import { visibleFor, type DisplayMode } from "../display-mode";
import {
  computeUserStatus,
  formatBitsPerSecond,
  getUserQuota,
  isOnline,
} from "./users.helpers";
import type { UsersTopicQuotaEntry, UsersTopicUser } from "../realtime/topics";

export interface UserCardProps {
  user: UsersTopicUser;
  quotaEntry: UsersTopicQuotaEntry | undefined;
  mode: DisplayMode;
  now: number;
  onOpen: () => void;
  onActions: () => void;
}

// UserCard — the mobile list item (06-ui.md §Люди): name, online indicator,
// status pill, quota bar, connections/IPs — density filtered by display
// mode (critical: name+status+online only; basic: +quota/connections;
// extended: +recent IPs/ad tag/rate limits).
export function UserCard({ user, quotaEntry, mode, now, onOpen, onActions }: UserCardProps) {
  const quota = getUserQuota(user, quotaEntry);
  const status = computeUserStatus(user, quota, now);
  const online = isOnline(user);
  const longPress = useLongPress(onActions);

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`user-card-${user.username}`}
      className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 text-left"
      onClick={() => {
        if (longPress.consume()) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      {...longPress.handlers}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("h-2.5 w-2.5 shrink-0 rounded-full", online ? "bg-ok" : "bg-muted")}
            aria-label={online ? ru.people.online : ru.people.offline}
            title={online ? ru.people.online : ru.people.offline}
          />
          <span className="truncate font-medium text-text">{user.username}</span>
        </div>
        <IconButton
          aria-label={ru.people.actions.menu}
          data-testid={`user-card-actions-${user.username}`}
          onClick={(e) => {
            e.stopPropagation();
            onActions();
          }}
        >
          ⋮
        </IconButton>
      </div>

      <UserStatusPill status={status} />

      {visibleFor("basic", mode) && (
        <>
          <span className="text-xs tabular-nums text-text-muted">
            {ru.people.connections}: {user.current_connections} · {ru.people.activeIps}:{" "}
            {user.active_unique_ips}
          </span>
          <QuotaBar usedBytes={quota.usedBytes} limitBytes={quota.limitBytes} />
        </>
      )}

      {visibleFor("extended", mode) && (
        <span className="text-xs tabular-nums text-text-faint">
          {ru.people.recentIps}: {user.recent_unique_ips}
          {user.user_ad_tag ? ` · ${ru.people.adTag}: ${user.user_ad_tag}` : ""}
          {user.rate_limit_up_bps || user.rate_limit_down_bps
            ? ` · ${ru.people.rateUp} ${formatBitsPerSecond(user.rate_limit_up_bps ?? 0)} / ${ru.people.rateDown} ${formatBitsPerSecond(user.rate_limit_down_bps ?? 0)}`
            : ""}
        </span>
      )}
    </div>
  );
}
