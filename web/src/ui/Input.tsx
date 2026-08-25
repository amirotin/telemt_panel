import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  monospace?: boolean;
}

// Input — the single text-input primitive. Always 16px+ text (the iOS
// Safari rule: below 16px, focusing the field zooms the page in) and a
// 44px-tall tap target; callers set inputMode/autoCapitalize/etc as normal
// HTML props (e.g. inputMode="numeric" for quota, autoCapitalize="off" for
// hex secrets — 06-ui.md's form spec).
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, monospace, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full rounded-lg border border-border bg-surface-2 px-3.5 text-base text-text",
        "placeholder:text-text-faint",
        "focus-visible:border-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        monospace && "font-mono",
        className,
      )}
      {...rest}
    />
  );
});
