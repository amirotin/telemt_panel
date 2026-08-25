import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  sparkline?: ReactNode;
  className?: string;
}

// StatCard — the one "number + label" building block for dashboard widgets
// (Пульс's stat row and every widget built on it — 06-ui.md explicitly
// calls out reusing this instead of one-off widget layouts).
export function StatCard({ label, value, delta, sparkline, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl bg-surface p-4",
        className,
      )}
    >
      <span className="text-meta text-text-muted">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums text-text">{value}</span>
        {delta !== undefined && (
          <span className="text-xs tabular-nums text-text-muted">{delta}</span>
        )}
      </div>
      {sparkline && <div className="mt-1">{sparkline}</div>}
    </div>
  );
}
