import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { isUnlimitedQuota, quotaFillClass, quotaRatio } from "./quota.helpers";
import { useStrings } from "../i18n";

export type QuotaBarSize = "sm" | "md";

export interface QuotaBarProps {
  usedBytes: number;
  /** null/undefined limit means unlimited — renders a filled, non-warning bar. */
  limitBytes?: number | null;
  /** "sm" is the 4px hairline under a People row; "md" (default) is 6px. */
  size?: QuotaBarSize;
  /** Hide the "used / limit" caption — the row variant carries it in its own meta line. */
  showLabel?: boolean;
  /** Replace the default "used / limit" caption (e.g. the inspector's «12,4 из 50 ГБ»). */
  label?: ReactNode;
  className?: string;
}

const TRACK_HEIGHT: Record<QuotaBarSize, string> = { sm: "h-1", md: "h-1.5" };

// QuotaBar — user traffic quota (used/limit), the People list/detail's
// core visual. Unlimited quotas (limitBytes null) show a filled accent bar
// with no warning color, since there's no threshold to warn about.
export function QuotaBar({
  usedBytes,
  limitBytes,
  size = "md",
  showLabel = true,
  label,
  className,
}: QuotaBarProps) {
  const s = useStrings();
  const limit = limitBytes ?? null;
  const unlimited = isUnlimitedQuota(limit);
  const ratio = quotaRatio(usedBytes, limit);

  return (
    <div className={cn("flex w-full flex-col gap-1.5", className)}>
      <div className={cn("w-full overflow-hidden rounded-full bg-bar-track", TRACK_HEIGHT[size])}>
        <div
          className={cn("h-full rounded-full transition-[width]", quotaFillClass(ratio, unlimited))}
          style={{ width: `${ratio * 100}%` }}
          role="progressbar"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      {showLabel && (
        <span className="text-meta tabular-nums text-text-muted">
          {label ?? `${formatBytes(usedBytes, s)} / ${limit === null ? "∞" : formatBytes(limit, s)}`}
        </span>
      )}
    </div>
  );
}
