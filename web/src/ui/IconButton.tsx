import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  "aria-label": string;
  variant?: "ghost" | "solid";
}

// IconButton — icon-only tap target, 44x44 minimum. aria-label is required
// (not optional) since there's no visible text to fall back on.
export function IconButton({
  children,
  className,
  variant = "ghost",
  ...rest
}: IconButtonProps) {
  return (
    <button
      className={cn(
        "tap-target inline-flex items-center justify-center rounded-full",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "ghost"
          ? "bg-transparent text-text-muted hover:bg-surface-2 hover:text-text"
          : "bg-surface-2 text-text hover:bg-surface-3",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
