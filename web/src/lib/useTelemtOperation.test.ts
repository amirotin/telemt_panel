import { describe, expect, it } from "vitest";
import {
  OPERATION_POLL_MS,
  isTerminalWebOperationState,
  pollUntilTerminal,
} from "./useTelemtOperation";
import type { WebControlOperationStatus } from "./api/generated/types.gen";
import { webOperationCompleted, webOperationQueued } from "../pulse/details-builder/__fixtures__";

const interval = pollUntilTerminal<WebControlOperationStatus>((data) =>
  isTerminalWebOperationState(data.state),
);

function query(data?: WebControlOperationStatus) {
  return { state: { data } };
}

describe("polling an asynchronous Telemt operation", () => {
  it("keeps polling while nothing has arrived yet", () => {
    // A query that has not answered at all must not be read as terminal —
    // that would stop the poll before the operation had even started.
    expect(interval(query())).toBe(OPERATION_POLL_MS);
  });

  it("keeps polling a queued or running operation", () => {
    expect(interval(query(webOperationQueued))).toBe(OPERATION_POLL_MS);
    expect(interval(query({ ...webOperationQueued, state: "running" }))).toBe(OPERATION_POLL_MS);
  });

  it("stops the moment the operation can no longer change", () => {
    expect(interval(query(webOperationCompleted))).toBe(false);
    for (const state of ["completed", "cancelled", "failed"] as const) {
      expect(interval(query({ ...webOperationQueued, state })), state).toBe(false);
    }
  });

  it("classifies every state Telemt can report", () => {
    // web/manager/control.rs's ControlOperationState, in full.
    expect(isTerminalWebOperationState("queued")).toBe(false);
    expect(isTerminalWebOperationState("running")).toBe(false);
    expect(isTerminalWebOperationState("completed")).toBe(true);
    expect(isTerminalWebOperationState("cancelled")).toBe(true);
    expect(isTerminalWebOperationState("failed")).toBe(true);
  });

  it("takes the terminal rule as a parameter, so a second operation kind can reuse it", () => {
    // The reload stepper's own terminal set (succeeded|rolled_back|failed)
    // is a different one; the shared half is the cadence and the "stop when
    // terminal" shape, which is what this proves is not WEB-specific.
    const reload = pollUntilTerminal<{ state: string }>((d) => d.state === "succeeded", 1500);
    expect(reload({ state: { data: { state: "draining" } } })).toBe(1500);
    expect(reload({ state: { data: { state: "succeeded" } } })).toBe(false);
  });
});
