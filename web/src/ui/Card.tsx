import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface CardProps {
  className?: string;
  children: ReactNode;
}

// Card — the prototype's panel: a flat `--sur` block with a 14px radius and
// no border (the border only appears in the light theme, where surface and
// page are both near-white). Every screen's "block of related content" is
// this, so the app has one card and not one per section.
export function Card({ className, children }: CardProps) {
  return (
    <div className={cn("rounded-xl bg-surface p-4", className)}>{children}</div>
  );
}

// CardList — the same card used as a *list* container: rows own their own
// vertical padding and hairline, so the card only supplies the horizontal
// inset (the prototype writes `padding:6px 16px` on these).
export function CardList({ className, children }: CardProps) {
  return (
    <div className={cn("rounded-xl bg-surface px-4", className)}>
      {children}
    </div>
  );
}

export interface CardRowProps {
  className?: string;
  children: ReactNode;
}

// CardRow — one row inside a CardList: 46px minimum (the prototype's row
// height), a hairline under everything but the last row.
export function CardRow({ className, children }: CardRowProps) {
  return (
    <div
      className={cn(
        "flex min-h-[46px] items-center gap-3 border-b border-border py-2 last:border-b-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface CardTitleProps {
  className?: string;
  children: ReactNode;
  /** Trailing slot — a StatePill, a count, a link. */
  action?: ReactNode;
}

// CardTitle — the 13px semibold heading the prototype puts at the top of a
// card, with an optional trailing slot on the same baseline.
export function CardTitle({ className, children, action }: CardTitleProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <h3 className="min-w-0 truncate text-[13px] font-semibold text-text">
        {children}
      </h3>
      {action !== undefined && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>
      )}
    </div>
  );
}
