import { describe, expect, it } from "vitest";
import {
  OPERATION_POLL_LIMIT,
  OPERATION_POLL_MAX_MS,
  OPERATION_POLL_MS,
  isTerminalWebOperationState,
  pollUntilTerminal,
} from "./useTelemtOperation";
import type { WebControlOperationStatus } from "./api/generated/types.gen";
import { webOperationCompleted, webOperationQueued } from "../pulse/details-builder/__fixtures__";

const interval = pollUntilTerminal<WebControlOperationStatus>((data) =>
  isTerminalWebOperationState(data.state),
);

// The schedule is a pure function of React Query's own counters, so every
// case below is decided synchronously — no timers, no sleeps, no clock.
function query(data?: WebControlOperationStatus, answers = 1, errors = 0) {
  return { state: { data, dataUpdateCount: answers, errorUpdateCount: errors } };
}

describe("polling an asynchronous Telemt operation", () => {
  it("keeps polling while nothing has arrived yet", () => {
    // A query that has not answered at all must not be read as terminal —
    // that would stop the poll before the operation had even started.
    expect(interval(query(undefined, 0))).toBe(OPERATION_POLL_MS);
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

  it("backs off from one second to five and stays there", () => {
    const at = (answers: number) => interval(query(webOperationQueued, answers));
    expect([at(1), at(2), at(3), at(4)]).toEqual([1000, 2000, 4000, OPERATION_POLL_MAX_MS]);
    expect(at(10)).toBe(OPERATION_POLL_MAX_MS);
  });

  it("gives up after the cap instead of asking forever", () => {
    // Telemt keeps only the last 32 operations, so an aged-out id answers
    // 404 for the life of the page. React Query keeps a refetchInterval
    // running while a query is in `error`, which is what used to make that
    // a permanent 1 Hz poll of a permanently-failing endpoint.
    expect(interval(query(webOperationQueued, OPERATION_POLL_LIMIT - 1))).toBe(
      OPERATION_POLL_MAX_MS,
    );
    expect(interval(query(webOperationQueued, OPERATION_POLL_LIMIT))).toBe(false);
  });

  it("counts a FAILED poll against the cap, not just an answered one", () => {
    // The failing case is the one the cap exists for: with data still
    // undefined, only errorUpdateCount moves.
    expect(interval(query(undefined, 0, OPERATION_POLL_LIMIT - 1))).toBe(OPERATION_POLL_MAX_MS);
    expect(interval(query(undefined, 0, OPERATION_POLL_LIMIT))).toBe(false);
  });

  it("classifies every state Telemt can report", () => {
    // web/manager/control.rs's ControlOperationState, in full.
    expect(isTerminalWebOperationState("queued")).toBe(false);
    expect(isTerminalWebOperationState("running")).toBe(false);
    expect(isTerminalWebOperationState("completed")).toBe(true);
    expect(isTerminalWebOperationState("cancelled")).toBe(true);
    expect(isTerminalWebOperationState("failed")).toBe(true);
  });

  it("takes the terminal rule and the schedule as parameters, so a second operation kind can reuse them", () => {
    // The reload stepper's own terminal set (succeeded|rolled_back|failed)
    // is a different one; the shared half is the cadence and the "stop when
    // terminal" shape, which is what this proves is not WEB-specific.
    const reload = pollUntilTerminal<{ state: string }>((d) => d.state === "succeeded", {
      startMs: 1500,
      maxMs: 1500,
      maxPolls: 3,
    });
    const at = (state: string, answers: number) => reload({ state: { data: { state }, dataUpdateCount: answers, errorUpdateCount: 0 } });
    expect(at("draining", 1)).toBe(1500);
    expect(at("draining", 3)).toBe(false);
    expect(at("succeeded", 1)).toBe(false);
  });
});
