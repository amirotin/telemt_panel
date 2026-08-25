import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { Avatar } from "../ui/Avatar";
import { CountBadge } from "../ui/Chip";
import { IconButton } from "../ui/IconButton";
import { IconMore } from "../ui/icons";
import { quotaFillClass } from "../ui/quota.helpers";
import { useLongPress } from "./useLongPress";
import { visibleFor, type DisplayMode } from "../display-mode";
import { computeUserStatus, formatBitsPerSecond, getUserQuota, isOnline } from "./users.helpers";
import { personAvatarTone, personBadge, personMeta } from "./personMeta.helpers";
import type { UsersTopicQuotaEntry, UsersTopicUser } from "../realtime/topics";

export interface UserCardProps {
  user: UsersTopicUser;
  quotaEntry: UsersTopicQuotaEntry | undefined;
  mode: DisplayMode;
  now: number;
  /** Highlights the row as the one the `lg:` Инспектор is showing. */
  selected?: boolean;
  onOpen: () => void;
  onActions: () => void;
}

const META_TONE = {
  muted: "text-text-muted",
  error: "text-error",
  warn: "text-warn",
  faint: "text-text-faint",
} as const;

// UserCard — one person in the Люди list. The prototype uses the same row
// at every width (a table on `lg:` would break the Инспектор's
// two-column reading), so this is the single list item for both the phone
// and the desktop list column: avatar + presence dot, name, a one-line
// summary, an activity/quota hairline and the live connection badge.
// Density still follows the display mode — `critical` drops the bar and
// the extended tail, `extended` adds recent IPs / ad tag / rate limits.
export function UserCard({
  user,
  quotaEntry,
  mode,
  now,
  selected,
  onOpen,
  onActions,
}: UserCardProps) {
  const quota = getUserQuota(user, quotaEntry);
  const status = computeUserStatus(user, quota, now);
  const online = isOnline(user);
  const longPress = useLongPress(onActions);
  const meta = personMeta({ user, status, quota });
  const badge = personBadge({ user, status });

  const hasBar = visibleFor("basic", mode) && quota.limitBytes !== null && status !== "disabled";
  const ratio =
    quota.limitBytes && quota.limitBytes > 0 ? Math.min(1, quota.usedBytes / quota.limitBytes) : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`user-card-${user.username}`}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex cursor-pointer select-none items-center gap-3 px-4 transition-colors",
        selected ? "bg-surface-2" : "hover:bg-surface/60",
      )}
      onClick={() => {
        if (longPress.consume()) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      {...longPress.handlers}
    >
      <Avatar
        name={user.username}
        tone={personAvatarTone(user, status)}
        online={online}
        ringOn={selected ? "surface" : "bg"}
      />

      {/* The divider lives on the text block, not the row, so it starts
          past the avatar — the prototype's list rhythm. */}
      <div className="min-w-0 flex-1 border-b border-border py-3">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[15px] font-semibold",
              status === "disabled" ? "text-text-faint" : "text-text",
            )}
          >
            {user.username}
          </span>
          {online && (
            <span className="shrink-0 text-micro text-ok">{ru.people.online}</span>
          )}
        </div>

        <div className="mt-0.5 flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-meta tabular-nums", META_TONE[meta.tone])}>
            {meta.text}
          </span>
          {badge && <CountBadge tone={badge.tone}>{badge.text}</CountBadge>}
        </div>

        {hasBar && (
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-bar-track">
            <div
              className={cn("h-full rounded-full", quotaFillClass(ratio, false))}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
        )}

        {visibleFor("extended", mode) && (
          <div className="mt-1.5 truncate text-micro tabular-nums text-text-faint">
            {ru.people.recentIps}: {user.recent_unique_ips}
            {user.user_ad_tag ? ` · ${ru.people.adTag}: ${user.user_ad_tag}` : ""}
            {user.rate_limit_up_bps || user.rate_limit_down_bps
              ? ` · ${ru.people.rateUp} ${formatBitsPerSecond(user.rate_limit_up_bps ?? 0)} / ${ru.people.rateDown} ${formatBitsPerSecond(user.rate_limit_down_bps ?? 0)}`
              : ""}
          </div>
        )}
      </div>

      <IconButton
        aria-label={ru.people.actions.menu}
        data-testid={`user-card-actions-${user.username}`}
        className="h-11 w-9 min-w-9 rounded-md"
        onClick={(e) => {
          e.stopPropagation();
          onActions();
        }}
      >
        <IconMore />
      </IconButton>
    </div>
  );
}
