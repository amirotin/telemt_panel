import { useState } from "react";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { useStrings } from "../i18n";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { IconEdit, IconMore } from "../ui/icons";
import { KVRow } from "../ui/KVRow";
import { Skeleton } from "../ui/Skeleton";
import { useUsersTopic, findQuotaEntry } from "./useUsersTopic";
import { useNow } from "./useNow";
import { SublinkPanel } from "./SublinkPanel";
import { UserActionSheet, type ActionSheetIntent } from "./UserActionSheet";
import { ExpiryLine, IpCards, PersonLinks, PersonQuotaCard, SectionLabel } from "./PersonSections";
import { computeUserStatus, formatBitsPerSecond, getUserQuota, isOnline } from "./users.helpers";
import { personAvatarTone } from "./personMeta.helpers";
import { WebAccessPanel } from "./WebAccessPanel";
import type { UsersTopicUser } from "../realtime/topics";

export interface PersonInspectorProps {
  username: string;
  onClose: () => void;
  onEdit: (user: UsersTopicUser) => void;
}

type InspectorTab = "overview" | "access" | "limits";

export function PersonInspector({ username, onClose, onEdit }: PersonInspectorProps) {
  const s = useStrings();
  const topic = useUsersTopic();
  const now = useNow();
  const [intent, setIntent] = useState<ActionSheetIntent | null>(null);
  const [tab, setTab] = useState<InspectorTab>(() => takeQueuedInspectorTab());
  const [tabUsername, setTabUsername] = useState(username);
  if (tabUsername !== username) {
    setTabUsername(username);
    setTab(takeQueuedInspectorTab());
  }
  const user = topic.users.find((candidate) => candidate.username === username);

  return (
    <aside aria-label={s.people.inspector.title} className="person-inspector-panel hidden flex-col lg:flex">
      {!user ? (
        topic.isPending ? <div className="flex flex-col gap-3 p-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-48 w-full" /></div> : <p className="p-6 text-meta text-text-muted">{s.people.notFoundTitle}</p>
      ) : (
        <>
          <header className="person-inspector-head shrink-0">
            <Avatar className="people-square-avatar" name={user.username} size="md" tone={personAvatarTone(user, computeUserStatus(user, getUserQuota(user, findQuotaEntry(topic.quota, user.username)), now))} online={isOnline(user)} ringOn="surface" />
            <div className="min-w-0 flex-1"><strong className="block truncate text-[15px] text-text">{user.username}</strong><InspectorStatus user={user} now={now} /></div>
            <IconButton aria-label={s.people.actions.edit} onClick={() => onEdit(user)}><IconEdit /></IconButton>
            <IconButton aria-label={s.people.actions.menu} onClick={() => setIntent("menu")}><IconMore /></IconButton>
          </header>

          <InspectorVitals user={user} quotaEntry={findQuotaEntry(topic.quota, user.username)} />
          <nav className="person-tab-list shrink-0" role="tablist" aria-label={s.people.inspector.title}>
            {(["overview", "access", "limits"] as const).map((key) => <button key={key} type="button" role="tab" aria-selected={tab === key} className="person-tab-button flex-1" onClick={() => setTab(key)}>{s.people.inspector.tabs[key]}</button>)}
          </nav>

          <div className="person-panel-body">
            {tab === "overview" && <OverviewTab user={user} now={now} quotaEntry={findQuotaEntry(topic.quota, user.username)} />}
            {tab === "access" && <AccessTab user={user} onIntent={setIntent} />}
            {tab === "limits" && <LimitsTab user={user} now={now} quotaEntry={findQuotaEntry(topic.quota, user.username)} onEdit={() => onEdit(user)} />}
          </div>
        </>
      )}

      <UserActionSheet key={intent ?? "closed"} open={intent !== null} intent={intent ?? "menu"} user={user ?? null} onClose={() => setIntent(null)} onEdit={onEdit} onDeleted={onClose} />
    </aside>
  );
}

function takeQueuedInspectorTab(): InspectorTab {
  try {
    const queued = window.sessionStorage.getItem("telemt-panel:people:initial-tab");
    window.sessionStorage.removeItem("telemt-panel:people:initial-tab");
    return queued === "access" ? "access" : "overview";
  } catch {
    return "overview";
  }
}

function InspectorStatus({ user, now }: { user: UsersTopicUser; now: number }) {
  const s = useStrings();
  const topic = useUsersTopic();
  const status = computeUserStatus(user, getUserQuota(user, findQuotaEntry(topic.quota, user.username)), now);
  const text = status === "active" ? isOnline(user) ? s.people.online : s.people.offline : s.people.status[status];
  return <span className={cn("mt-1 flex items-center gap-1.5 text-micro font-semibold", status === "active" ? isOnline(user) ? "text-ok" : "text-text-muted" : "text-warn")}><i className="h-1.5 w-1.5 rounded-full bg-current" />{text}</span>;
}

function InspectorVitals({ user, quotaEntry }: { user: UsersTopicUser; quotaEntry: ReturnType<typeof findQuotaEntry> }) {
  const s = useStrings();
  const quota = getUserQuota(user, quotaEntry);
  const quotaCopy = quota.limitBytes === null ? s.people.allTime : `${Math.min(100, Math.round((quota.usedBytes / Math.max(1, quota.limitBytes)) * 100))}% ${s.people.quotaShort}`;
  const values = [
    [s.people.connections, String(user.current_connections), user.current_connections > 0 ? s.people.now : s.people.noConnections],
    [s.people.activeIps, String(user.active_unique_ips), user.max_unique_ips ? `${s.people.meta.of} ${user.max_unique_ips}` : s.people.form.quotaUnlimited],
    [s.shell.traffic, formatBytes(user.total_octets, s), quotaCopy],
  ];
  return <div className="person-vitals-grid shrink-0">{values.map(([label, value, note]) => <div key={label} className="person-vital-cell"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</div>;
}

function OverviewTab({ user, now, quotaEntry }: { user: UsersTopicUser; now: number; quotaEntry: ReturnType<typeof findQuotaEntry> }) {
  const s = useStrings();
  const activeIps = user.active_unique_ips_list ?? [];
  const recentIps = user.recent_unique_ips_list ?? [];
  return <div className="flex flex-col gap-5"><section><SectionLabel className="mb-2">{s.people.inspector.usage}</SectionLabel><PersonQuotaCard quota={getUserQuota(user, quotaEntry)} /></section><section className="border-t border-border pt-4"><SectionLabel className="mb-2">{s.people.detail.activeIpsTitle} · {activeIps.length}</SectionLabel><IpCards ips={activeIps} /></section><section className="border-t border-border pt-4"><SectionLabel className="mb-2">{s.people.detail.recentIpsTitle} · {recentIps.length}</SectionLabel><IpCards ips={recentIps} /></section><div className="border-t border-border pt-3"><KVRow label={s.people.form.expiry} value={<ExpiryLine expirationRfc3339={user.expiration_rfc3339} now={now} />} /><KVRow label={s.people.runtimeState} value={user.in_runtime ? s.people.runtimeLoaded : s.people.status.not_in_runtime} /></div></div>;
}

function AccessTab({ user, onIntent }: { user: UsersTopicUser; onIntent: (intent: ActionSheetIntent) => void }) {
  const s = useStrings();
  return <div className="flex flex-col gap-5"><section><SectionLabel className="mb-2">{s.people.inspector.accessLink}</SectionLabel><SublinkPanel username={user.username} compact /></section><section><WebAccessPanel username={user.username} /></section><section><SectionLabel className="mb-2">{s.people.detail.linksTitle}</SectionLabel><div className="flex flex-col gap-2"><PersonLinks links={user.links} compact /></div></section><div className="flex gap-2 border-t border-border pt-4"><Button size="sm" variant="secondary" className="flex-1" onClick={() => onIntent("reset-quota")}>{s.people.actions.resetQuota}</Button><Button size="sm" variant="secondary" className="flex-1 text-warn" onClick={() => onIntent("toggle-enabled")}>{user.enabled ? s.people.actions.disable : s.people.actions.enable}</Button><Button size="sm" variant="danger" onClick={() => onIntent("delete")}>{s.people.actions.delete}</Button></div></div>;
}

function LimitsTab({ user, now, quotaEntry, onEdit }: { user: UsersTopicUser; now: number; quotaEntry: ReturnType<typeof findQuotaEntry>; onEdit: () => void }) {
  const s = useStrings();
  const quota = getUserQuota(user, quotaEntry);
  const unlimited = s.people.form.quotaUnlimited;
  return <div className="flex flex-col gap-4"><div className="rounded-xl bg-bg px-3"><KVRow label={s.people.form.maxConnections} value={user.max_tcp_conns ?? unlimited} /><KVRow label={s.people.form.maxIps} value={user.max_unique_ips ?? unlimited} /><KVRow label={s.people.form.rateUpLabel} value={user.rate_limit_up_bps ? formatBitsPerSecond(user.rate_limit_up_bps, s) : unlimited} /><KVRow label={s.people.form.rateDownLabel} value={user.rate_limit_down_bps ? formatBitsPerSecond(user.rate_limit_down_bps, s) : unlimited} /><KVRow label={s.people.form.quota} value={quota.limitBytes === null ? unlimited : formatBytes(quota.limitBytes, s)} /><KVRow label={s.people.form.expiry} value={<ExpiryLine expirationRfc3339={user.expiration_rfc3339} now={now} />} />{user.user_ad_tag && <KVRow label={s.people.adTag} value={user.user_ad_tag} monospace />}</div><Button variant="secondary" onClick={onEdit}>{s.people.actions.edit}</Button></div>;
}
