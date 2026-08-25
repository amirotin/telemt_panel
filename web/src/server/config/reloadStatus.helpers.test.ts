import { describe, expect, it } from "vitest";
import { isTerminalReloadState, reloadStepInfo, type ReloadState } from "./reloadStatus.helpers";

const HAPPY_PATH: ReloadState[] = ["accepted", "preparing", "activating", "draining", "succeeded"];

describe("reloadStepInfo", () => {
  it.each(HAPPY_PATH.map((state, index) => [state, index] as const))(
    "maps %s to step index %i on the happy path",
    (state, index) => {
      const info = reloadStepInfo(state);
      expect(info.stepIndex).toBe(index);
      expect(info.totalSteps).toBe(HAPPY_PATH.length);
    },
  );

  it("marks succeeded as a terminal success", () => {
    const info = reloadStepInfo("succeeded");
    expect(info.terminal).toBe(true);
    expect(info.outcome).toBe("success");
  });

  it("marks the intermediate states as non-terminal with no outcome", () => {
    for (const state of ["accepted", "preparing", "activating", "draining"] as const) {
      const info = reloadStepInfo(state);
      expect(info.terminal).toBe(false);
      expect(info.outcome).toBeNull();
    }
  });

  it("marks rolled_back as a terminal error off the happy path", () => {
    const info = reloadStepInfo("rolled_back");
    expect(info.stepIndex).toBe(-1);
    expect(info.terminal).toBe(true);
    expect(info.outcome).toBe("error");
  });

  it("marks failed as a terminal error off the happy path", () => {
    const info = reloadStepInfo("failed");
    expect(info.stepIndex).toBe(-1);
    expect(info.terminal).toBe(true);
    expect(info.outcome).toBe("error");
  });
});

describe("isTerminalReloadState", () => {
  it("is false for every non-terminal state", () => {
    for (const state of ["accepted", "preparing", "activating", "draining"] as const) {
      expect(isTerminalReloadState(state)).toBe(false);
    }
  });

  it("is true for every terminal state", () => {
    for (const state of ["succeeded", "rolled_back", "failed"] as const) {
      expect(isTerminalReloadState(state)).toBe(true);
    }
  });
});
