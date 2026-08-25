import { describe, expect, it } from "vitest";
import {
  isTerminalUpdatePhase,
  shouldPollUpdates,
  sortJournalDesc,
  updatePhaseStep,
  type UpdatePhase,
} from "./updatePhase.helpers";
import type { UpdateRun } from "../../lib/api/generated/types.gen";

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

describe("updatePhaseStep", () => {
  it.each(HAPPY_PATH.map((phase, index) => [phase, index] as const))(
    "maps %s to step index %i",
    (phase, index) => {
      const step = updatePhaseStep(phase);
      expect(step.stepIndex).toBe(index);
      expect(step.totalSteps).toBe(HAPPY_PATH.length);
    },
  );

  it("marks done as a terminal success", () => {
    const step = updatePhaseStep("done");
    expect(step.terminal).toBe(true);
    expect(step.outcome).toBe("success");
  });

  it("marks every non-terminal happy-path phase with no outcome", () => {
    for (const phase of HAPPY_PATH.slice(0, -1)) {
      const step = updatePhaseStep(phase);
      expect(step.terminal).toBe(false);
      expect(step.outcome).toBeNull();
    }
  });

  it("marks rolling_back as active (non-terminal) but off the happy path", () => {
    const step = updatePhaseStep("rolling_back");
    expect(step.stepIndex).toBe(-1);
    expect(step.terminal).toBe(false);
    expect(step.outcome).toBe("rolling_back");
  });

  it("marks rolled_back and failed as terminal errors off the happy path", () => {
    for (const phase of ["rolled_back", "failed"] as const) {
      const step = updatePhaseStep(phase);
      expect(step.stepIndex).toBe(-1);
      expect(step.terminal).toBe(true);
      expect(step.outcome).toBe("error");
    }
  });
});

describe("isTerminalUpdatePhase", () => {
  it("is true only for done/rolled_back/failed", () => {
    for (const phase of ["done", "rolled_back", "failed"] as const) {
      expect(isTerminalUpdatePhase(phase)).toBe(true);
    }
    for (const phase of ["checking", "downloading", "installing", "restarting", "rolling_back"] as const) {
      expect(isTerminalUpdatePhase(phase)).toBe(false);
    }
  });
});

describe("shouldPollUpdates", () => {
  it("never polls without an active run, regardless of connection state", () => {
    expect(shouldPollUpdates("closed", false)).toBe(false);
    expect(shouldPollUpdates("open", false)).toBe(false);
  });

  it("polls with an active run whenever the connection isn't open", () => {
    expect(shouldPollUpdates("connecting", true)).toBe(true);
    expect(shouldPollUpdates("reconnecting", true)).toBe(true);
    expect(shouldPollUpdates("polling", true)).toBe(true);
    expect(shouldPollUpdates("closed", true)).toBe(true);
  });

  it("does not poll with an active run when the connection is open", () => {
    expect(shouldPollUpdates("open", true)).toBe(false);
  });
});

describe("sortJournalDesc", () => {
  function run(id: string, startedAt: string): UpdateRun {
    return { run_id: id, target: "telemt", phase: "done", version_to: "1.0.0", started_at: startedAt };
  }

  it("orders entries newest first", () => {
    const entries = [run("a", "2026-08-20T00:00:00Z"), run("b", "2026-08-25T00:00:00Z"), run("c", "2026-08-22T00:00:00Z")];
    expect(sortJournalDesc(entries).map((e) => e.run_id)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const entries = [run("a", "2026-08-20T00:00:00Z"), run("b", "2026-08-25T00:00:00Z")];
    const original = [...entries];
    sortJournalDesc(entries);
    expect(entries).toEqual(original);
  });

  it("returns an empty array unchanged", () => {
    expect(sortJournalDesc([])).toEqual([]);
  });
});
