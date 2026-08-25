import { cn } from "../../lib/cn";
import { ru } from "../../i18n/ru";
import { StatePill } from "../../ui/StatePill";
import { updatePhaseStep, type UpdatePhase } from "./updatePhase.helpers";

const HAPPY_PHASES: UpdatePhase[] = [
  "checking",
  "downloading",
  "verifying",
  "staging",
  "installing",
  "restarting",
  "health",
  "done",
];

// UpdateStepper — the live phase stepper for one update run
// (03-update-engine.md's state machine), fed by whichever source
// UpdateTarget picked (SSE `update` topic or the REST snapshot's
// `active_run` fallback).
export function UpdateStepper({ phase, detail }: { phase: UpdatePhase; detail?: string }) {
  const step = updatePhaseStep(phase);

  if (step.outcome === "error" || step.outcome === "rolling_back") {
    return (
      <div className="flex flex-col gap-1">
        <StatePill state={step.outcome === "error" ? "error" : "warn"}>
          {ru.server.updates.phases[phase]}
        </StatePill>
        {detail && <p className="text-xs text-text-muted">{detail}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-1 gap-1" role="list" aria-label={ru.server.updates.title}>
        {HAPPY_PHASES.map((p, i) => (
          <span
            key={p}
            role="listitem"
            title={ru.server.updates.phases[p]}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i <= step.stepIndex ? (step.outcome === "success" ? "bg-ok" : "bg-accent") : "bg-surface-3",
            )}
          />
        ))}
      </div>
      <span className="shrink-0 text-xs text-text-muted">{ru.server.updates.phases[phase]}</span>
    </div>
  );
}
