import type { UpdateRun, UpdatesStatus } from "../../lib/api/generated/types.gen";
import { isTerminalUpdatePhase, sortJournalDesc, updatePhaseStep } from "./updatePhase.helpers";

type TargetStatus = Pick<UpdatesStatus["targets"][number], "target" | "active_run" | "journal">;

// Journal timestamps describe transitions; SSE and active_run timestamps
// describe the run's start. Across different runs both preserve their order.
export function selectUpdateRun(data: TargetStatus, event: UpdateRun | null): UpdateRun | null {
  const journal = sortJournalDesc(data.journal ?? [])[0];
  const candidates = [event, data.active_run, journal];
  let latest: UpdateRun | null = null;
  for (const candidate of candidates) {
    if (!candidate || candidate.target !== data.target) continue;
    if (!latest) {
      latest = candidate;
      continue;
    }
    if (candidate.run_id !== latest.run_id) {
      if (Date.parse(candidate.started_at) >= Date.parse(latest.started_at)) latest = candidate;
      continue;
    }
    const terminal = isTerminalUpdatePhase(candidate.phase);
    const latestTerminal = isTerminalUpdatePhase(latest.phase);
    if (latestTerminal && !terminal) continue;
    if (terminal || candidate.phase === "rolling_back" ||
      (latest.phase !== "rolling_back" && updatePhaseStep(candidate.phase).stepIndex >= updatePhaseStep(latest.phase).stepIndex)) {
      latest = candidate;
    }
  }
  return latest;
}
