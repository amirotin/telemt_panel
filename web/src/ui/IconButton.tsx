import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  "aria-label": string;
  variant?: "ghost" | "solid" | "accent";
}

const variantClasses: Record<NonNullable<IconButtonProps["variant"]>, string> = {
  ghost: "bg-transparent text-text-faint hover:bg-surface-2 hover:text-text",
  solid: "bg-surface-2 text-text hover:bg-surface-3",
  accent: "bg-accent-strong text-accent-text shadow-lg hover:bg-accent",
};

// IconButton — icon-only tap target, 44x44 minimum. aria-label is required
// (not optional) since there's no visible text to fall back on. The 18px
// font-size is what sizes the inline SVGs from ui/icons.tsx, which are all
// authored at 1em; callers that want a different glyph size override it
// with a `text-*` class.
export function IconButton({
  children,
  className,
  variant = "ghost",
  ...rest
}: IconButtonProps) {
  return (
    <button
      className={cn(
        "tap-target inline-flex items-center justify-center rounded-full text-[18px]",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
