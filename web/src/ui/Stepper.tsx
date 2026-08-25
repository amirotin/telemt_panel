import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { IconButton } from "./IconButton";
import { IconMinus, IconPlus } from "./icons";

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  className?: string;
}

// Stepper — numeric +/- control for small bounded integers (connection
// limits, IP limits): steppers read better than a bare number input for
// values people nudge by one or two, per 06-ui.md's form spec.
export function Stepper({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  label,
  className,
}: StepperProps) {
  const s = useStrings();
  const dec = () => onChange(Math.max(min, value - step));
  const inc = () => onChange(Math.min(max, value + step));

  return (
    <div
      className={cn("inline-flex items-center gap-1", className)}
      role="group"
      aria-label={label}
    >
      <IconButton
        aria-label={s.ui.stepperDecrease}
        variant="solid"
        onClick={dec}
        disabled={value <= min}
      >
        <IconMinus />
      </IconButton>
      <span className="w-12 text-center text-base tabular-nums text-text">{value}</span>
      <IconButton
        aria-label={s.ui.stepperIncrease}
        variant="solid"
        onClick={inc}
        disabled={value >= max}
      >
        <IconPlus />
      </IconButton>
    </div>
  );
}
