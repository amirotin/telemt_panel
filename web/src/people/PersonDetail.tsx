import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { AsyncState } from "../components/AsyncState";
import { IconButton } from "../ui/IconButton";
import { StatCard } from "../ui/StatCard";
import { QuotaBar } from "../ui/QuotaBar";
import { KVRow } from "../ui/KVRow";
import { useDisplayMode, visibleFor, type DisplayMode } from "../display-mode";
import { useConnectionState } from "../realtime";
import { useUsersTopic, findQuotaEntry } from "./useUsersTopic";
import { useNow } from "./useNow";
import { UserStatusPill } from "./UserStatusPill";
import { UserActionSheet } from "./UserActionSheet";
import { UserFormSheet } from "./UserFormSheet";
import { SublinkPanel } from "./SublinkPanel";
import { LinkCard } from "./LinkCard";
import { computeUserStatus, formatBitsPerSecond, getUserQuota, isOnline } from "./users.helpers";
import { formatDurationApprox } from "./expiry";
import type { UsersTopicUser } from "../realtime/topics";

// PersonDetail — /people/$username (06-ui.md §Люди): live metrics from the
// "users" SSE topic, quota bar, IP cards, per-field connection links, and
// sub-link management — everything the action sheet also offers, plus the
// full data the list only summarizes.
export function PersonDetail({ username }: { username: string }) {
  const topic = useUsersTopic();
  const connection = useConnectionState();
  const { mode } = useDisplayMode();
  const now = useNow();
  const navigate = useNavigate();

  const [actionsOpen, setActionsOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <Link to="/people" className="w-fit text-sm text-text-muted hover:text-text">
        ← {ru.nav.people}
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
  const hasExtras = !!user.user_ad_tag || !!user.rate_limit_up_bps || !!user.rate_limit_down_bps;

  const classicLink = user.links.classic[0];
  const secureLink = user.links.secure[0];
  const tlsLink = user.links.tls[0];
  const hasTlsDomains = user.links.tls_domains.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("h-2.5 w-2.5 shrink-0 rounded-full", isOnline(user) ? "bg-ok" : "bg-muted")}
            aria-label={isOnline(user) ? ru.people.online : ru.people.offline}
          />
          <h1 className="truncate text-lg font-semibold text-text">{user.username}</h1>
          <UserStatusPill status={status} />
        </div>
        <IconButton aria-label={ru.people.actions.menu} onClick={onOpenActions}>
          ⋮
        </IconButton>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <StatCard label={ru.people.connections} value={user.current_connections} />
        <StatCard label={ru.people.activeIps} value={user.active_unique_ips} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-text-muted">{ru.people.form.quota}</h2>
        <QuotaBar usedBytes={quota.usedBytes} limitBytes={quota.limitBytes} />
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-text-muted">{ru.people.form.expiry}</h2>
        <ExpiryLine expirationRfc3339={user.expiration_rfc3339} now={now} />
      </section>

      {visibleFor("basic", mode) && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-text-muted">{ru.people.detail.activeIpsTitle}</h2>
          <IPCardsList ips={activeIps} />
        </section>
      )}

      {visibleFor("extended", mode) && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-text-muted">{ru.people.detail.recentIpsTitle}</h2>
          <IPCardsList ips={recentIps} />
        </section>
      )}

      {visibleFor("extended", mode) && hasExtras && (
        <section className="flex flex-col">
          {user.user_ad_tag && <KVRow label={ru.people.adTag} value={user.user_ad_tag} monospace />}
          {!!user.rate_limit_up_bps && (
            <KVRow label={ru.people.rateUp} value={formatBitsPerSecond(user.rate_limit_up_bps)} />
          )}
          {!!user.rate_limit_down_bps && (
            <KVRow label={ru.people.rateDown} value={formatBitsPerSecond(user.rate_limit_down_bps)} />
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-text-muted">{ru.people.share.title}</h2>
        <SublinkPanel username={user.username} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-text-muted">{ru.people.detail.linksTitle}</h2>
        {classicLink && <LinkCard label={ru.people.detail.linkTypeClassic} link={classicLink} />}
        {secureLink && <LinkCard label={ru.people.detail.linkTypeSecure} link={secureLink} />}
        {hasTlsDomains
          ? user.links.tls_domains.map((d) => (
              <LinkCard key={d.domain} label={`${ru.people.detail.linkTypeTls} — ${d.domain}`} link={d.link} />
            ))
          : tlsLink && <LinkCard label={ru.people.detail.linkTypeTls} link={tlsLink} />}
      </section>

      {actionsSheet}
      {formSheet}
    </div>
  );
}

function IPCardsList({ ips }: { ips: string[] }) {
  if (ips.length === 0) {
    return <p className="text-sm text-text-faint">{ru.common.empty}</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {ips.map((ip) => (
        <span
          key={ip}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-sm text-text"
        >
          {ip}
        </span>
      ))}
    </div>
  );
}

function ExpiryLine({ expirationRfc3339, now }: { expirationRfc3339: string | undefined; now: number }) {
  if (!expirationRfc3339) {
    return <span className="text-sm text-text-muted">{ru.people.detail.noExpiry}</span>;
  }
  const target = Date.parse(expirationRfc3339);
  if (Number.isNaN(target)) {
    return <span className="text-sm text-text-muted">{ru.people.detail.noExpiry}</span>;
  }
  const expired = target <= now;
  const amount = formatDurationApprox(Math.abs(target - now));
  const text = (expired ? ru.people.detail.expiredAgoTemplate : ru.people.detail.expiresInTemplate).replace(
    "{amount}",
    amount,
  );
  return <span className={cn("text-sm", expired ? "text-error" : "text-text-muted")}>{text}</span>;
}
