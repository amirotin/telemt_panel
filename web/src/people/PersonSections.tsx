import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { quotaFillClass } from "../ui/quota.helpers";
import { formatDurationApprox } from "./expiry";
import { quotaSummary } from "./personMeta.helpers";
import type { UserQuotaView } from "./users.helpers";

// PersonSections — the pieces the full-screen detail (/people/$username on
// mobile) and the `lg:` Инспектор both render. They live here rather than
// inside PersonDetail so the inspector is a second *layout* over the same
// components, not a second implementation that can drift from it.

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={cn(
        "text-micro font-semibold uppercase tracking-[0.06em] text-text-faint",
        className,
      )}
    >
      {children}
    </h2>
  );
}

// PersonQuotaCard — the recessed quota card from the prototype: a caption
// row (label left, figures right) over the fill bar.
export function PersonQuotaCard({ quota, className }: { quota: UserQuotaView; className?: string }) {
  const unlimited = quota.limitBytes === null || quota.limitBytes <= 0;
  const ratio = unlimited ? 1 : Math.min(1, quota.usedBytes / quota.limitBytes!);

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
