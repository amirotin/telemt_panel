import { useState } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { IconClose } from "../ui/icons";
import { Skeleton } from "../ui/Skeleton";
import { useDisplayMode, visibleFor } from "../display-mode";
import { useUsersTopic, findQuotaEntry } from "./useUsersTopic";
import { useNow } from "./useNow";
import { SublinkPanel } from "./SublinkPanel";
import { UserActionSheet, type ActionSheetIntent } from "./UserActionSheet";
import {
  IpCards,
  PersonExtras,
  PersonLinks,
  PersonQuotaCard,
  SectionLabel,
} from "./PersonSections";
import { computeUserStatus, getUserQuota, isOnline } from "./users.helpers";
import { personAvatarTone, personHasExtras } from "./personMeta.helpers";
import { formatDurationApprox } from "./expiry";
import type { UsersTopicUser } from "../realtime/topics";

export interface PersonInspectorProps {
  username: string;
  onClose: () => void;
  onEdit: (user: UsersTopicUser) => void;
}

const STATUS_TONE = {
  active: "text-ok",
  disabled: "text-text-faint",
  expired: "text-warn",
  quota_exhausted: "text-error",
  not_in_runtime: "text-warn",
} as const;

// PersonInspector — the `lg:`-only right-hand panel (prototype: «Инспектор»)
// showing the selected person beside the list instead of replacing it. It
// is a second layout over PersonSections/SublinkPanel/UserActionSheet, not
// a second implementation: every action here opens the same action sheet at
// the matching confirmation step, so the mutation, the wording and the
// toast are literally the ones the mobile sheet uses.
export function PersonInspector({ username, onClose, onEdit }: PersonInspectorProps) {
  const topic = useUsersTopic();
  const now = useNow();
  const { mode } = useDisplayMode();
  const [intent, setIntent] = useState<ActionSheetIntent | null>(null);

  const user = topic.users.find((u) => u.username === username);

  return (
    <aside
      aria-label={ru.people.inspector.title}
      className="hidden w-[348px] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface p-4 lg:flex"
    >
      <div className="flex shrink-0 items-center gap-1">
        <span className="flex-1 text-[15px] font-bold text-text">{ru.people.inspector.title}</span>
        {user && (
          <Button variant="ghost" size="sm" onClick={() => onEdit(user)}>
            {ru.people.actions.edit}
          </Button>
        )}
        <IconButton
          aria-label={ru.common.close}
          className="h-9 w-9 min-h-9 min-w-9"
          onClick={onClose}
        >
          <IconClose />
        </IconButton>
      </div>

      {!user ? (
        topic.isPending ? (
          <div className="mt-4 flex flex-col gap-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <p className="mt-6 text-meta text-text-muted">{ru.people.notFoundTitle}</p>
        )
      ) : (
        <InspectorBody
          user={user}
          quotaEntry={findQuotaEntry(topic.quota, user.username)}
          now={now}
          showExtended={visibleFor("extended", mode)}
          onIntent={setIntent}
        />
      )}

      <UserActionSheet
        key={intent ?? "closed"}
        open={intent !== null}
        intent={intent ?? "menu"}
        user={user ?? null}
        onClose={() => setIntent(null)}
        onEdit={onEdit}
        onDeleted={onClose}
      />
    </aside>
  );
}

function InspectorBody({
  user,
  quotaEntry,
  now,
  showExtended,
  onIntent,
}: {
  user: UsersTopicUser;
  quotaEntry: ReturnType<typeof findQuotaEntry>;
  now: number;
  showExtended: boolean;
  onIntent: (intent: ActionSheetIntent) => void;
}) {
  const quota = getUserQuota(user, quotaEntry);
  const status = computeUserStatus(user, quota, now);
  const online = isOnline(user);
  const activeIps = user.active_unique_ips_list ?? [];

  return (
    <>
      <div className="mt-2.5 flex items-center gap-3">
        <Avatar
          name={user.username}
          size="md"
          tone={personAvatarTone(user, status)}
          online={online}
          ringOn="surface"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold text-text">{user.username}</div>
          <div className={cn("mt-0.5 truncate text-micro", STATUS_TONE[status])}>
            {inspectorStatusLine(user, status, online, now)}
          </div>
        </div>
      </div>

      <PersonQuotaCard quota={quota} className="mt-3.5" />

      <SectionLabel className="mb-1.5 mt-3.5">
        {ru.people.detail.activeIpsTitle} · {activeIps.length}
      </SectionLabel>
      <IpCards ips={activeIps} />

      {showExtended && (
        <>
          <SectionLabel className="mb-1.5 mt-3.5">{ru.people.detail.recentIpsTitle}</SectionLabel>
          <IpCards ips={user.recent_unique_ips_list ?? []} />
        </>
      )}

      <SectionLabel className="mb-1.5 mt-3.5">{ru.people.inspector.accessLink}</SectionLabel>
      <SublinkPanel username={user.username} compact />

      <div className="mt-3.5 flex gap-1.5">
        <Button size="sm" variant="secondary" className="flex-1" onClick={() => onIntent("reset-quota")}>
          {ru.people.actions.resetQuota}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1 text-warn"
          onClick={() => onIntent("toggle-enabled")}
        >
          {user.enabled ? ru.people.actions.disable : ru.people.actions.enable}
        </Button>
        <Button size="sm" variant="danger" className="flex-1" onClick={() => onIntent("delete")}>
          {ru.people.actions.delete}
        </Button>
      </div>

      {/* Below the actions, matching the prototype's inspector order
          (header → quota → IPs → access link → actions): the per-field
          connection links and the rarely-set extras. Before this, the `lg:`
          Outlet never rendered, so PersonDetail's own copies of these were
          simply unreachable on a desktop — same components, narrow layout. */}
      <SectionLabel className="mb-1.5 mt-4">{ru.people.detail.linksTitle}</SectionLabel>
      <div className="flex flex-col gap-2">
        <PersonLinks links={user.links} compact />
      </div>

      {showExtended && personHasExtras(user) && (
        <>
          <SectionLabel className="mb-1.5 mt-4">{ru.people.form.advanced}</SectionLabel>
          <PersonExtras user={user} />
        </>
      )}
    </>
  );
}

// inspectorStatusLine — the prototype's «онлайн · 3 соед · до 15 сен»
// header line, degraded honestly: a problem state names itself, and the
// expiry half is dropped entirely for an access with no expiration rather
// than printing a placeholder date.
function inspectorStatusLine(
  user: UsersTopicUser,
  status: ReturnType<typeof computeUserStatus>,
  online: boolean,
  now: number,
): string {
  if (status !== "active") return ru.people.status[status];

  const parts = [
    online
      ? `${ru.people.online.toLowerCase()} · ${user.current_connections} ${ru.shell.connectionsShort}`
      : ru.people.offline.toLowerCase(),
  ];
  const target = user.expiration_rfc3339 ? Date.parse(user.expiration_rfc3339) : NaN;
  if (!Number.isNaN(target)) {
    parts.push(
      ru.people.detail.expiresInTemplate.replace("{amount}", formatDurationApprox(target - now)),
    );
  }
  return parts.join(" · ");
}
