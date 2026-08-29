import { cn } from "../lib/cn";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Required: the switch has no visible label of its own. */
  "aria-label": string;
  className?: string;
}

// Toggle — the prototype's 42×25 pill switch with a 20px white knob, used
// for every on/off setting (автообновление, read-only, Passkey…). A real
// <button role="switch"> rather than a restyled checkbox so the pressed
// state, the 44px tap area and the focus ring all come from one place.
export function Toggle({ checked, onChange, disabled, className, ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={rest["aria-label"]}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[25px] w-[42px] shrink-0 items-center rounded-full",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-accent-strong" : "bg-surface-3",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[2.5px] h-5 w-5 rounded-full bg-control-knob shadow-sm transition-[left]",
          checked ? "left-[19.5px]" : "left-[2.5px]",
        )}
      />
    </button>
  );
}
