import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** "sm" is the 38-40px compact row the inspector/panel action rows use. */
  size?: ButtonSize;
  children: ReactNode;
}

// Variants follow the prototype's button language: a solid accent primary,
// a flat surface-2 secondary with no border, and a *soft* danger (tinted
// wash + red label, like its «Удалить») rather than a solid red slab — a
// full-bleed red button reads as the page's loudest element even when it
// is the rarest action.
const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent-strong text-accent-text hover:bg-accent active:brightness-95",
  secondary: "bg-surface-2 text-text hover:bg-surface-3 active:bg-surface-3",
  ghost: "bg-transparent text-text-muted hover:bg-surface-2 hover:text-text",
  danger: "bg-error/12 text-error hover:bg-error/20 active:bg-error/25",
};

const sizeClasses: Record<ButtonSize, string> = {
  md: "tap-target rounded-lg px-4 text-[15px]",
  sm: "min-h-[38px] rounded-md px-2.5 text-micro",
};

// Button is the single interactive-button primitive — min 44x44 touch
// target (tap-target utility, styles/index.css) is enforced here, not left
// to callers, per 06-ui.md. `size="sm"` opts a control out of that floor
// only inside a dense panel row where the prototype itself uses 38-40px
// (Инспектор's Копировать/QR/Перевыпуск triple).
export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
