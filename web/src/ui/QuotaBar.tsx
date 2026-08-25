import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";

export interface QuotaBarProps {
  usedBytes: number;
  /** null/undefined limit means unlimited — renders a filled, non-warning bar. */
  limitBytes?: number | null;
  className?: string;
}

// QuotaBar — user traffic quota (used/limit), the People list/detail's
// core visual. Unlimited quotas (limitBytes null) show a filled accent bar
// with no warning color, since there's no threshold to warn about.
export function QuotaBar({ usedBytes, limitBytes, className }: QuotaBarProps) {
  const limit = limitBytes ?? null;
  const ratio = limit === null || limit <= 0 ? 1 : Math.min(1, usedBytes / limit);
  const barColor =
    limit === null ? "bg-accent" : ratio >= 1 ? "bg-error" : ratio >= 0.85 ? "bg-warn" : "bg-accent";

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={cn("h-full rounded-full transition-[width]", barColor)}
          style={{ width: `${ratio * 100}%` }}
          role="progressbar"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <span className="text-xs tabular-nums text-text-muted">
        {formatBytes(usedBytes)} / {limit === null ? "∞" : formatBytes(limit)}
      </span>
    </div>
  );
}
