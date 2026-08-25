import type { ReloadStatus } from "../../lib/api/generated/types.gen";

export type ReloadState = ReloadStatus["state"];

// RELOAD_STEPS is the happy path from 07-telemt-sdk.md/03-update-engine's
// reload state machine: accepted→preparing→activating→draining→succeeded.
// rolled_back/failed are alternate terminal outcomes, not steps on this
// path — a compact stepper renders them as an error state instead of a
// step index.
const RELOAD_STEPS: ReloadState[] = ["accepted", "preparing", "activating", "draining", "succeeded"];

export interface ReloadStepInfo {
  /** Index into the happy-path steps, -1 for an off-path error terminal. */
  stepIndex: number;
  totalSteps: number;
  terminal: boolean;
  outcome: "success" | "error" | null;
}

// reloadStepInfo maps GET /api/telemt/reload/{id}'s `state` to the compact
// stepper's view model — pure so the polling hook and the UI can both stay
// thin.
export function reloadStepInfo(state: ReloadState): ReloadStepInfo {
  if (state === "rolled_back" || state === "failed") {
    return { stepIndex: -1, totalSteps: RELOAD_STEPS.length, terminal: true, outcome: "error" };
  }
  const idx = RELOAD_STEPS.indexOf(state);
  return {
    stepIndex: idx,
    totalSteps: RELOAD_STEPS.length,
    terminal: state === "succeeded",
    outcome: state === "succeeded" ? "success" : null,
  };
}

export function isTerminalReloadState(state: ReloadState): boolean {
  return state === "succeeded" || state === "rolled_back" || state === "failed";
}
