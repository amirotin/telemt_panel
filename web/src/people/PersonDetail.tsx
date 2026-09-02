import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { useStrings } from "../i18n";
import { AsyncState } from "../components/AsyncState";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { IconChevronLeft, IconMore } from "../ui/icons";
import { KVRow } from "../ui/KVRow";
import { useConnectionState } from "../realtime";
import { useUsersTopic, findQuotaEntry } from "./useUsersTopic";
import { useNow } from "./useNow";
import { UserActionSheet } from "./UserActionSheet";
import { UserFormSheet } from "./UserFormSheet";
import { SublinkPanel } from "./SublinkPanel";
import { ExpiryLine, IpCards, PersonLinks, PersonQuotaCard, SectionLabel } from "./PersonSections";
import { computeUserStatus, formatBitsPerSecond, getUserQuota, isOnline } from "./users.helpers";
import { personAvatarTone } from "./personMeta.helpers";
import { WebAccessPanel } from "./WebAccessPanel";
import type { UsersTopicUser } from "../realtime/topics";

type DetailTab = "overview" | "access" | "limits";

// Phone portrait gets a real detail screen. The list, its filters and its
// create control are not mounted at this route, so nothing behind the back
// action can be mistaken for controls of the selected user.
export function PersonDetail({ username }: { username: string }) {
  const s = useStrings();
  const topic = useUsersTopic();
  const connection = useConnectionState();
  const now = useNow();
  const navigate = useNavigate();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>(() => {
    try {
      const queued = window.sessionStorage.getItem("telemt-panel:people:initial-tab");
      window.sessionStorage.removeItem("telemt-panel:people:initial-tab");
      return queued === "access" ? "access" : "overview";
    } catch {
      return "overview";
    }
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-24">
      <AsyncState
        isPending={topic.isPending}
        isError={topic.isError}
        errorCode={topic.errorCode ?? undefined}
        data={topic.users}
        isEmpty={(users) => !users.some((user) => user.username === username)}
        emptyTitle={s.people.notFoundTitle}
        stale={topic.stale || connection.stale}
        onRetry={connection.retry}
      >
        {(users) => {
          const user = users.find((candidate) => candidate.username === username)!;
          const quotaEntry = findQuotaEntry(topic.quota, user.username);
          const quota = getUserQuota(user, quotaEntry);
          const status = computeUserStatus(user, quota, now);
          return (
            <>
              <header className="person-inspector-head min-h-[76px] bg-surface px-3 py-3">
                <Link to="/people" aria-label={s.common.back} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-text-muted"><IconChevronLeft className="h-5 w-5" /></Link>
                <Avatar className="people-square-avatar" name={user.username} size="md" tone={personAvatarTone(user, status)} online={isOnline(user)} ringOn="surface" />
                <div className="min-w-0 flex-1"><h1 className="truncate text-[16px] font-bold text-text">{user.username}</h1><span className={cn("mt-1 block truncate text-micro font-semibold", status === "active" ? isOnline(user) ? "text-ok" : "text-text-muted" : "text-warn")}>{status === "active" ? isOnline(user) ? s.people.online : s.people.offline : s.people.status[status]}</span></div>
                <IconButton aria-label={s.people.actions.menu} onClick={() => setActionsOpen(true)}><IconMore /></IconButton>
              </header>

              <MobileVitals user={user} quotaEntry={quotaEntry} />
              <nav className="person-tab-list bg-surface" role="tablist">
                {(["overview", "access", "limits"] as const).map((key) => <button key={key} type="button" role="tab" aria-selected={tab === key} className="person-tab-button" onClick={() => setTab(key)}>{s.people.inspector.tabs[key]}</button>)}
              </nav>

              <div className="flex flex-col gap-5 px-4 py-4">
                {tab === "overview" && <MobileOverview user={user} now={now} />}
                {tab === "access" && <MobileAccess user={user} />}
                {tab === "limits" && <MobileLimits user={user} now={now} onEdit={() => setFormOpen(true)} />}
              </div>

              <UserActionSheet open={actionsOpen} user={user} onClose={() => setActionsOpen(false)} onEdit={() => setFormOpen(true)} onDeleted={() => navigate({ to: "/people" })} />
              <UserFormSheet open={formOpen} mode="edit" user={user} onClose={() => setFormOpen(false)} />
            </>
          );
        }}
      </AsyncState>
    </div>
  );
}

function MobileVitals({ user, quotaEntry }: { user: UsersTopicUser; quotaEntry: ReturnType<typeof findQuotaEntry> }) {
  const s = useStrings();
  const quota = getUserQuota(user, quotaEntry);
  const note = quota.limitBytes === null ? s.people.allTime : `${Math.min(100, Math.round((quota.usedBytes / Math.max(1, quota.limitBytes)) * 100))}% ${s.people.quotaShort}`;
  return <div className="person-vitals-grid bg-surface">{[[s.people.connections, String(user.current_connections), s.people.now], [s.people.activeIps, String(user.active_unique_ips), user.max_unique_ips ? `${s.people.meta.of} ${user.max_unique_ips}` : "∞"], [s.shell.traffic, formatBytes(user.total_octets, s), note]].map(([label, value, caption]) => <div key={label} className="person-vital-cell"><span>{label}</span><strong>{value}</strong><small>{caption}</small></div>)}</div>;
}

function MobileOverview({ user, now }: { user: UsersTopicUser; now: number }) {
  const s = useStrings();
  const topic = useUsersTopic();
  const activeIps = user.active_unique_ips_list ?? [];
  const recentIps = user.recent_unique_ips_list ?? [];
  return <><section><SectionLabel className="mb-2">{s.people.inspector.usage}</SectionLabel><PersonQuotaCard quota={getUserQuota(user, findQuotaEntry(topic.quota, user.username))} /></section><section className="border-t border-border pt-4"><SectionLabel className="mb-2">{s.people.detail.activeIpsTitle} · {activeIps.length}</SectionLabel><IpCards ips={activeIps} /></section><section className="border-t border-border pt-4"><SectionLabel className="mb-2">{s.people.detail.recentIpsTitle} · {recentIps.length}</SectionLabel><IpCards ips={recentIps} /></section><div className="border-t border-border pt-3"><KVRow label={s.people.form.expiry} value={<ExpiryLine expirationRfc3339={user.expiration_rfc3339} now={now} />} /><KVRow label={s.people.runtimeState} value={user.in_runtime ? s.people.runtimeLoaded : s.people.status.not_in_runtime} /></div></>;
}

function MobileAccess({ user }: { user: UsersTopicUser }) {
  const s = useStrings();
  return <><section><SectionLabel className="mb-2">{s.people.inspector.accessLink}</SectionLabel><SublinkPanel username={user.username} /></section><section><WebAccessPanel username={user.username} /></section><section><SectionLabel className="mb-2">{s.people.detail.linksTitle}</SectionLabel><div className="flex flex-col gap-2"><PersonLinks links={user.links} /></div></section></>;
}

function MobileLimits({ user, now, onEdit }: { user: UsersTopicUser; now: number; onEdit: () => void }) {
  const s = useStrings();
  const unlimited = s.people.form.quotaUnlimited;
  return <><div className="rounded-xl bg-surface px-3"><KVRow label={s.people.form.maxConnections} value={user.max_tcp_conns ?? unlimited} /><KVRow label={s.people.form.maxIps} value={user.max_unique_ips ?? unlimited} /><KVRow label={s.people.form.rateUpLabel} value={user.rate_limit_up_bps ? formatBitsPerSecond(user.rate_limit_up_bps, s) : unlimited} /><KVRow label={s.people.form.rateDownLabel} value={user.rate_limit_down_bps ? formatBitsPerSecond(user.rate_limit_down_bps, s) : unlimited} /><KVRow label={s.people.form.quota} value={user.data_quota_bytes ? formatBytes(user.data_quota_bytes, s) : unlimited} /><KVRow label={s.people.form.expiry} value={<ExpiryLine expirationRfc3339={user.expiration_rfc3339} now={now} />} />{user.user_ad_tag && <KVRow label={s.people.adTag} value={user.user_ad_tag} monospace />}</div><Button variant="secondary" onClick={onEdit}>{s.people.actions.edit}</Button></>;
}
