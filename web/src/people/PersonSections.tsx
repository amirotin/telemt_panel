import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { isUnlimitedQuota, quotaFillClass, quotaRatio } from "../ui/quota.helpers";
import { formatDurationApprox } from "./expiry";
import { quotaSummary } from "./personMeta.helpers";
import type { UserQuotaView } from "./users.helpers";

// PersonSections — the pieces the full-screen detail (/people/$username on
// mobile) and the `lg:` Инспектор both render. They live here rather than
// inside PersonDetail so the inspector is a second *layout* over the same
// components, not a second implementation that can drift from it.

// PersonQuotaCard — the recessed quota card from the prototype: a caption
// row (label left, figures right) over the fill bar.
export function PersonQuotaCard({ quota, className }: { quota: UserQuotaView; className?: string }) {
  const s = useStrings();
  const unlimited = isUnlimitedQuota(quota.limitBytes);
  const ratio = unlimited || quota.usedBytes === null ? 0 : quotaRatio(quota.usedBytes, quota.limitBytes);

  return (
    <div className={cn("rounded-xl bg-bg px-3.5 py-3", className)}>
      <div className="flex items-baseline justify-between gap-3 text-micro">
        <span className="text-text-muted">{s.people.detail.quota}</span>
        <span className="font-mono tabular-nums text-text">{quotaSummary(quota, s)}</span>
      </div>
      <div hidden={quota.usedBytes===null} className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bar-track">
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
  const s = useStrings();
  const target = expirationRfc3339 ? Date.parse(expirationRfc3339) : NaN;
  if (Number.isNaN(target)) {
    return (
      <span className={cn("text-meta text-text-muted", className)}>{s.people.detail.noExpiry}</span>
    );
  }
  const expired = target <= now;
  const amount = formatDurationApprox(Math.abs(target - now), s);
  const text = (
    expired ? s.people.detail.expiredAgoTemplate : s.people.detail.expiresInTemplate
  ).replace("{amount}", amount);
  return (
    <span className={cn("text-meta", expired ? "text-error" : "text-text-muted", className)}>
      {text}
    </span>
  );
}
