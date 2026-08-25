import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface KVRowProps {
  label: string;
  value: ReactNode;
  monospace?: boolean;
  className?: string;
}

// KVRow — key/value row for diagnostics screens (Диагностика subpages,
// config/security/host detail dumps): one layout for every "parameter —
// value" pair in the app instead of ad hoc grids per screen.
export function KVRow({ label, value, monospace, className }: KVRowProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0",
        className,
      )}
    >
      <span className="shrink-0 text-sm text-text-muted">{label}</span>
      <span
        className={cn(
          "truncate text-right text-sm tabular-nums text-text",
          monospace && "font-mono",
        )}
      >
        {value}
      </span>
    </div>
  );
}
