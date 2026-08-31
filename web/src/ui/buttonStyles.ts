import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

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

// buttonClasses is the recipe ui/Button applies, in its own module so it can
// also dress the one control a <button> cannot be: one that NAVIGATES. A
// router <Link> wearing these classes keeps the button's look while staying
// an anchor — the right element for overview's shared «Детали →», and the one that
// middle-click and "open in new tab" actually work on.
//
// It lives here rather than in Button.tsx so that file keeps exporting only
// components (react-refresh/only-export-components).
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold",
    "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    sizeClasses[size],
    variantClasses[variant],
    className,
  );
}
