import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export type State = "ok" | "warn" | "error" | "muted";

export interface StatePillProps {
  state: State;
  children: ReactNode;
  /** Native tooltip — the long form of a state the pill names in one word. */
  title?: string;
  className?: string;
}

const stateClasses: Record<State, string> = {
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  error: "bg-error/15 text-error",
  muted: "bg-muted/15 text-muted",
};

const dotClasses: Record<State, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  error: "bg-error",
  muted: "bg-muted",
};

// StatePill is the ONE status-semantics component for the whole app —
// ok/warn/error/muted, nothing else (06-ui.md: v1 had two parallel status
// vocabularies, this is deliberately the single one).
export function StatePill({ state, children, title, className }: StatePillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-micro font-semibold",
        stateClasses[state],
        className,
      )}
      title={title}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClasses[state])} aria-hidden="true" />
      {children}
    </span>
  );
}
