import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-text hover:brightness-110 active:brightness-95",
  secondary:
    "bg-surface-2 text-text border border-border hover:bg-surface-3 active:bg-surface-3",
  ghost: "bg-transparent text-text hover:bg-surface-2 active:bg-surface-3",
  danger: "bg-error text-white hover:brightness-110 active:brightness-95",
};

// Button is the single interactive-button primitive — min 44x44 touch
// target (tap-target utility, styles/index.css) is enforced here, not left
// to callers, per 06-ui.md.
export function Button({ variant = "primary", className, children, ...rest }: ButtonProps) {
  return (
    <button
      className={cn(
        "tap-target inline-flex items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-medium",
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
