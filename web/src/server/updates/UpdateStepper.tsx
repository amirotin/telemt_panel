import { ru } from "../../i18n/ru";
import { StatePill } from "../../ui/StatePill";
import { PhaseSteps, type PhaseStep } from "../PhaseSteps";
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
// `active_run` fallback). Renders through the shared PhaseSteps so a
// reload and an update look like the same kind of operation.
export function UpdateStepper({
  phase,
  detail,
}: {
  phase: UpdatePhase;
  detail?: string;
}) {
  const step = updatePhaseStep(phase);

  if (step.outcome === "error" || step.outcome === "rolling_back") {
    return (
      <div className="flex flex-col gap-1.5">
        <StatePill state={step.outcome === "error" ? "error" : "warn"}>
          {ru.server.updates.phases[phase]}
        </StatePill>
        {detail && <p className="text-meta text-text-muted">{detail}</p>}
      </div>
    );
  }

  const steps: PhaseStep[] = HAPPY_PHASES.map((p, i) => ({
    key: p,
    label: ru.server.updates.phases[p],
    state:
      i < step.stepIndex ? "done" : i === step.stepIndex ? "active" : "pending",
  }));

  return (
    <div className="flex flex-col gap-2">
      <PhaseSteps
        steps={steps}
        label={ru.server.updates.title}
        progress={(step.stepIndex + 1) / HAPPY_PHASES.length}
        succeeded={step.outcome === "success"}
      />
      {detail && (
        <p className="font-mono text-micro text-text-faint">{detail}</p>
      )}
    </div>
  );
}
