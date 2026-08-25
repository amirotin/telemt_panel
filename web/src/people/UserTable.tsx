import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { IconButton } from "../ui/IconButton";
import { QuotaBar } from "../ui/QuotaBar";
import { UserStatusPill } from "./UserStatusPill";
import { visibleFor, type DisplayMode } from "../display-mode";
import { computeUserStatus, formatBitsPerSecond, getUserQuota, isOnline } from "./users.helpers";
import type { UsersTopicQuotaEntry, UsersTopicUser } from "../realtime/topics";

export interface UserTableProps {
  users: UsersTopicUser[];
  quota: Record<string, UsersTopicQuotaEntry> | null;
  mode: DisplayMode;
  now: number;
  onOpen: (user: UsersTopicUser) => void;
  onActions: (user: UsersTopicUser) => void;
}

// UserTable — the `lg:` desktop equivalent of UserCard's mobile list
// (06-ui.md §Люди: "на lg: — таблица"), same density filtering by display
// mode, same underlying status/quota computation.
export function UserTable({ users, quota, mode, now, onOpen, onActions }: UserTableProps) {
  const showBasic = visibleFor("basic", mode);
  const showExtended = visibleFor("extended", mode);

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th className="px-3 py-2 font-medium">{ru.people.form.username}</th>
            <th className="px-3 py-2 font-medium" />
            {showBasic && <th className="px-3 py-2 font-medium">{ru.people.connections}</th>}
            {showBasic && <th className="px-3 py-2 font-medium">{ru.people.form.quota}</th>}
            {showExtended && <th className="px-3 py-2 font-medium">{ru.people.recentIps}</th>}
            {showExtended && <th className="px-3 py-2 font-medium">{ru.people.rateLimits}</th>}
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const q = getUserQuota(user, quota?.[user.username]);
            const status = computeUserStatus(user, q, now);
            const online = isOnline(user);
            return (
              <tr
                key={user.username}
                className="cursor-pointer border-b border-border last:border-b-0 hover:bg-surface-2"
                onClick={() => onOpen(user)}
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn("h-2 w-2 shrink-0 rounded-full", online ? "bg-ok" : "bg-muted")}
                      aria-label={online ? ru.people.online : ru.people.offline}
                      title={online ? ru.people.online : ru.people.offline}
                    />
                    <span className="font-medium text-text">{user.username}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <UserStatusPill status={status} />
                </td>
                {showBasic && (
                  <td className="px-3 py-2 tabular-nums text-text-muted">
                    {user.current_connections} · {user.active_unique_ips} IP
                  </td>
                )}
                {showBasic && (
                  <td className="px-3 py-2">
                    <QuotaBar usedBytes={q.usedBytes} limitBytes={q.limitBytes} className="min-w-32" />
                  </td>
                )}
                {showExtended && (
                  <td className="px-3 py-2 tabular-nums text-text-faint">{user.recent_unique_ips}</td>
                )}
                {showExtended && (
                  <td className="px-3 py-2 tabular-nums text-text-faint">
                    {formatBitsPerSecond(user.rate_limit_up_bps ?? 0)} /{" "}
                    {formatBitsPerSecond(user.rate_limit_down_bps ?? 0)}
                  </td>
                )}
                <td className="px-3 py-2 text-right">
                  <IconButton
                    aria-label={ru.people.actions.menu}
                    onClick={(e) => {
                      e.stopPropagation();
                      onActions(user);
                    }}
                  >
                    ⋮
                  </IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
