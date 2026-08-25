import type { UpdateRun } from "../../lib/api/generated/types.gen";
import type { ConnectionStatus } from "../../realtime";

export type UpdatePhase = UpdateRun["phase"];

// HAPPY_PATH mirrors 03-update-engine.md's state machine:
// idle ─▶ checking ─▶ downloading ─▶ verifying ─▶ staging ─▶ installing ─▶
// restarting ─▶ health ─▶ done. "idle" isn't a phase UpdateRun ever reports
// (no run exists yet), so it isn't in this list.
const HAPPY_PATH: UpdatePhase[] = [
  "checking",
  "downloading",
  "verifying",
  "staging",
  "installing",
  "restarting",
  "health",
  "done",
];

export interface UpdatePhaseStep {
  /** Index into the happy path, -1 for an off-path outcome (rolling_back/rolled_back/failed). */
  stepIndex: number;
  totalSteps: number;
  terminal: boolean;
  outcome: "success" | "error" | "rolling_back" | null;
}

// updatePhaseStep maps one UpdateRun.phase to the live stepper's view
// model. rolling_back is a distinct (non-terminal) outcome from
// rolled_back/failed — the run is still active, just moving backward, so
// the UI shows a spinner-with-warning rather than a final error state.
export function updatePhaseStep(phase: UpdatePhase): UpdatePhaseStep {
  if (phase === "rolling_back") {
    return { stepIndex: -1, totalSteps: HAPPY_PATH.length, terminal: false, outcome: "rolling_back" };
  }
  if (phase === "rolled_back" || phase === "failed") {
    return { stepIndex: -1, totalSteps: HAPPY_PATH.length, terminal: true, outcome: "error" };
  }
  const idx = HAPPY_PATH.indexOf(phase);
  return {
    stepIndex: idx,
    totalSteps: HAPPY_PATH.length,
    terminal: phase === "done",
    outcome: phase === "done" ? "success" : null,
  };
}

export function isTerminalUpdatePhase(phase: UpdatePhase): boolean {
  return phase === "done" || phase === "rolled_back" || phase === "failed";
}

// shouldPollUpdates decides the "SSE отвалился → поллинг снапшота"
// fallback (06-ui.md §Обновления): only worth polling while a run is
// actually active for this target, and only when the shared SSE connection
// isn't reporting a healthy "open" state — a merely "connecting" transient
// still counts as needing the fallback, since a fresh page load starts in
// that state before the first frame ever arrives.
export function shouldPollUpdates(connectionStatus: ConnectionStatus, hasActiveRun: boolean): boolean {
  return hasActiveRun && connectionStatus !== "open";
}

// sortJournalDesc orders update-journal entries newest first. The backend
// (store.ListUpdateJournal) already returns them this way, but the UI
// re-sorts defensively rather than trusting response order silently.
export function sortJournalDesc(entries: UpdateRun[]): UpdateRun[] {
  return [...entries].sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
}
