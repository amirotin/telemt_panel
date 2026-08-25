import { describe, expect, it } from "vitest";
import { currentPhaseIndex } from "./phaseSteps.helpers";
import type { PhaseStep } from "./PhaseSteps";

function steps(...states: PhaseStep["state"][]): PhaseStep[] {
  return states.map((state, i) => ({ key: `s${i}`, label: `Шаг ${i}`, state }));
}

describe("currentPhaseIndex", () => {
  it("points at the active step", () => {
    expect(currentPhaseIndex(steps("done", "done", "active", "pending"))).toBe(2);
  });

  it("points at the last completed step once nothing is active", () => {
    expect(currentPhaseIndex(steps("done", "done", "done"))).toBe(2);
  });

  it("points at the first step for a run that has not started", () => {
    expect(currentPhaseIndex(steps("pending", "pending"))).toBe(0);
  });

  it("never returns -1 for a non-empty list", () => {
    expect(currentPhaseIndex(steps("active"))).toBe(0);
    expect(currentPhaseIndex([])).toBe(-1);
  });
});
