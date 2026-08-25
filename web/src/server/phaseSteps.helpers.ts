import type { PhaseStep } from "./PhaseSteps";

// currentPhaseIndex — which step the dots are "on" right now.
//
// The active step wins. Once a run finishes there is no active step left
// (every entry is "done"), and the last one is the phase that actually
// completed, so that is what the caption should name — never index -1, and
// never the first pending step of a run that has not started.
export function currentPhaseIndex(steps: readonly PhaseStep[]): number {
  if (steps.length === 0) return -1;
  const active = steps.findIndex((s) => s.state === "active");
  if (active >= 0) return active;
  const lastDone = steps.map((s) => s.state).lastIndexOf("done");
  return lastDone >= 0 ? lastDone : 0;
}
