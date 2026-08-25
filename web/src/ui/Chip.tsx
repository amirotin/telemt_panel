import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** Selected state — paints the chip as the active filter/sort. */
  active?: boolean;
  /** Leading glyph slot (an icons.tsx component), rendered before the label. */
  icon?: ReactNode;
  /** Trailing count, rendered in tabular figures after a "·" like the prototype. */
  count?: number | string;
  children: ReactNode;
}

// Chip — the pill-shaped filter/sort control the prototype uses above the
// People list ("Все · 1 234", "Онлайн · 51", "Активность"). One primitive
// for both roles: a filter chip passes `count`, a sort chip passes `icon`.
// 34px tall like the prototype rather than the 44px primitives floor —
// these sit in a horizontal strip where a 44px pill would eat the list, and
// they are non-destructive, always-repeatable toggles (06-ui.md's touch
// rule is about the primary action targets); the row they live in keeps
// 44px of vertical rhythm around them.
export function Chip({ active, icon, count, className, children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "bg-text text-bg"
          : "bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {count !== undefined && (
        <span className={cn("tabular-nums", active ? "opacity-70" : "opacity-80")}>
          · {count}
        </span>
      )}
    </button>
  );
}

export type CountBadgeTone = "accent" | "error" | "warn" | "muted";

export interface CountBadgeProps {
  tone?: CountBadgeTone;
  children: ReactNode;
  className?: string;
}

const TONE_CLASSES: Record<CountBadgeTone, string> = {
  accent: "bg-accent text-white",
  error: "bg-error-strong text-white",
  warn: "bg-warn/15 text-warn",
  muted: "bg-surface-2 text-text-faint",
};

// CountBadge — the tiny pill at the right edge of a People row (live
// connection count for an online user, "STOP"/"срок"/"выкл" for one that
// needs attention). Monospace + tabular so a 1 and a 9 occupy the same
// width and the column of badges stays optically straight.
export function CountBadge({ tone = "accent", children, className }: CountBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-[19px] min-w-[20px] items-center justify-center rounded-full px-1.5",
        "font-mono text-[10.5px] font-semibold tabular-nums leading-none",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
