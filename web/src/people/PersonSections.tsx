import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { isUnlimitedQuota, quotaFillClass, quotaRatio } from "../ui/quota.helpers";
import { KVRow } from "../ui/KVRow";
import { LinkCard } from "./LinkCard";
import { formatDurationApprox } from "./expiry";
import { quotaSummary } from "./personMeta.helpers";
import { formatBitsPerSecond } from "./users.helpers";
import type { UsersTopicUser } from "../realtime/topics";
import type { UserQuotaView } from "./users.helpers";

// PersonSections — the pieces the full-screen detail (/people/$username on
// mobile) and the `lg:` Инспектор both render. They live here rather than
// inside PersonDetail so the inspector is a second *layout* over the same
// components, not a second implementation that can drift from it.

// SectionLabel moved to ui/ in D2 — Пульс, Журнал and Сервер caption their
// blocks with the same rule. Re-exported here so this module stays the one
// import site for the person sections.
export { SectionLabel } from "../ui/SectionLabel";

// PersonQuotaCard — the recessed quota card from the prototype: a caption
// row (label left, figures right) over the fill bar.
export function PersonQuotaCard({ quota, className }: { quota: UserQuotaView; className?: string }) {
  const unlimited = isUnlimitedQuota(quota.limitBytes);
  const ratio = quotaRatio(quota.usedBytes, quota.limitBytes);

  return (
    <div className={cn("rounded-xl bg-bg px-3.5 py-3", className)}>
      <div className="flex items-baseline justify-between gap-3 text-micro">
        <span className="text-text-muted">{ru.people.detail.quota}</span>
        <span className="font-mono tabular-nums text-text">{quotaSummary(quota)}</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bar-track">
        <div
          className={cn("h-full rounded-full transition-[width]", quotaFillClass(ratio, unlimited))}
          style={{ width: `${ratio * 100}%` }}
          role="progressbar"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

// IpCards — active/recent IP list. The design brief asks for geolocation
// on these cards; the "users" topic carries addresses only, so the card
// shows the address alone rather than a fabricated location.
export function IpCards({ ips }: { ips: string[] }) {
  if (ips.length === 0) {
    return (
      <div className="rounded-md bg-bg px-3 py-3 text-center text-micro text-text-muted">
        {ru.people.detail.noActiveIps}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {ips.map((ip) => (
        <div key={ip} className="rounded-md bg-bg px-3 py-2.5">
          <span className="font-mono text-meta tabular-nums text-text">{ip}</span>
        </div>
      ))}
    </div>
  );
}

// ExpiryLine — «Истекает через 12 дн.» / «Истёк 3 дн. назад» / «Бессрочно».
export function ExpiryLine({
  expirationRfc3339,
  now,
  className,
}: {
  expirationRfc3339: string | undefined;
  now: number;
  className?: string;
}) {
  const target = expirationRfc3339 ? Date.parse(expirationRfc3339) : NaN;
  if (Number.isNaN(target)) {
    return (
      <span className={cn("text-meta text-text-muted", className)}>{ru.people.detail.noExpiry}</span>
    );
  }
  const expired = target <= now;
  const amount = formatDurationApprox(Math.abs(target - now));
  const text = (
    expired ? ru.people.detail.expiredAgoTemplate : ru.people.detail.expiresInTemplate
  ).replace("{amount}", amount);
  return (
    <span className={cn("text-meta", expired ? "text-error" : "text-text-muted", className)}>
      {text}
    </span>
  );
}

// PersonLinks — the per-field connection links (classic / secure / one card
// per Fake-TLS domain). Rendered identically by the phone detail screen and
// the `lg:` Инспектор, which only differ by LinkCard's `compact` layout —
// the "which links does this user have" logic exists once, here.
export function PersonLinks({ links, compact }: { links: UsersTopicUser["links"]; compact?: boolean }) {
  const classicLink = links.classic[0];
  const secureLink = links.secure[0];
  const tlsLink = links.tls[0];
  const hasTlsDomains = links.tls_domains.length > 0;

  if (!classicLink && !secureLink && !tlsLink && !hasTlsDomains) {
    return <p className="text-meta text-text-muted">{ru.people.detail.noLinks}</p>;
  }

  return (
    <>
      {classicLink && (
        <LinkCard label={ru.people.detail.linkTypeClassic} link={classicLink} compact={compact} />
      )}
      {secureLink && (
        <LinkCard label={ru.people.detail.linkTypeSecure} link={secureLink} compact={compact} />
      )}
      {hasTlsDomains
        ? links.tls_domains.map((d) => (
            <LinkCard
              key={d.domain}
              label={`${ru.people.detail.linkTypeTls} — ${d.domain}`}
              link={d.link}
              compact={compact}
            />
          ))
        : tlsLink && (
            <LinkCard label={ru.people.detail.linkTypeTls} link={tlsLink} compact={compact} />
          )}
    </>
  );
}

// PersonExtras — the rarely-set per-user fields (ad tag, rate limits). Gated
// by the caller on visibleFor("extended"), like every other secondary block.
export function PersonExtras({ user, className }: { user: UsersTopicUser; className?: string }) {
  return (
    <div className={cn("flex flex-col rounded-xl bg-bg px-3.5", className)}>
      {user.user_ad_tag && <KVRow label={ru.people.adTag} value={user.user_ad_tag} monospace />}
      {!!user.rate_limit_up_bps && (
        <KVRow label={ru.people.rateUp} value={formatBitsPerSecond(user.rate_limit_up_bps)} />
      )}
      {!!user.rate_limit_down_bps && (
        <KVRow label={ru.people.rateDown} value={formatBitsPerSecond(user.rate_limit_down_bps)} />
      )}
    </div>
  );
}
