import { cn } from "../lib/cn";

export type PhaseStepState = "done" | "active" | "pending";

export interface PhaseStep {
  key: string;
  label: string;
  state: PhaseStepState;
}

const DOT_CLASSES: Record<PhaseStepState, string> = {
  done: "bg-ok",
  active: "bg-accent",
  pending: "bg-border-strong",
};

const LABEL_CLASSES: Record<PhaseStepState, string> = {
  done: "text-text-muted",
  active: "text-text font-semibold",
  pending: "text-text-faint",
};

export interface PhaseStepsProps {
  steps: PhaseStep[];
  /** Accessible name for the step list (there is no visible heading). */
  label: string;
  /** 0..1 — drawn as the prototype's thin progress bar above the dots. */
  progress: number;
  /** Paints the bar and the trailing dots green once the run has finished. */
  succeeded?: boolean;
  className?: string;
}

// PhaseSteps — the prototype's update/reload progress block: a thin bar
// over a vertical list of dots joined by a hairline, one per phase. Shared
// by Обновления (update-engine phases) and Конфигурация (reload states) so
// the two long-running operations in the panel read identically.
//
// The bar is filled by *step fraction*, never by a percentage: neither the
// update engine nor the reload API reports bytes or a real percent, and a
// number like "38%" would claim a precision the backend does not have.
export function PhaseSteps({
  steps,
  label,
  progress,
  succeeded,
  className,
}: PhaseStepsProps) {
  const clamped = Math.max(0, Math.min(1, progress));

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            succeeded ? "bg-ok" : "bg-accent",
          )}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
      <ol className="flex flex-col">
        {steps.map((step, i) => (
          <li
            key={step.key}
            className="flex items-start gap-2.5 last:pb-0 pb-2"
          >
            <span className="relative flex w-2 shrink-0 justify-center pt-[5px]">
              <span
                aria-hidden="true"
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  DOT_CLASSES[step.state],
                )}
              />
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 top-[13px] h-[calc(100%-5px)] w-0.5 -translate-x-1/2 bg-border"
                />
              )}
            </span>
            <span
              className={cn(
                "text-xs leading-[18px]",
                LABEL_CLASSES[step.state],
              )}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
