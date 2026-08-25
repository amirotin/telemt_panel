import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

// EmptyState — "nothing here yet, here's what to do" (06-ui.md's mandatory
// per-screen "empty" state — always paired with a next action, e.g. "create
// the first user", never a bare "no data").
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-surface/40 px-6 py-12 text-center",
        className,
      )}
    >
      <p className="text-sm font-semibold text-text">{title}</p>
      {description && <p className="text-meta text-text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
