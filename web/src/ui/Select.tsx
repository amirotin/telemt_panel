import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

// Select — native <select>, styled to match Input/Button. Native rather
// than a custom listbox: it's free keyboard/a11y support and the OS's own
// picker UI on mobile, which is what "quota unit" / "reload policy"
// dropdowns want anyway.
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-11 w-full rounded-lg border border-border bg-surface-2 px-3.5 text-base text-text",
        "focus-visible:border-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
