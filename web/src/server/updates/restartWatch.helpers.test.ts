import { describe, expect, it } from "vitest";
import { RESTART_WATCH_TIMEOUT_MS, restartWatchDecision } from "./restartWatch.helpers";

describe("restartWatchDecision", () => {
  it("waits while the OLD process keeps answering health checks (premature restarting-phase poll)", () => {
    expect(
      restartWatchDecision({ health: { version: "0.6.1" }, expectedVersion: "v0.6.2", elapsed: 2000 }),
    ).toBe("wait");
  });

  it("reloads once the NEW version answers", () => {
    expect(
      restartWatchDecision({ health: { version: "0.6.2" }, expectedVersion: "v0.6.2", elapsed: 4000 }),
    ).toBe("reload");
  });

  it("normalizes a leading 'v' on either side before comparing", () => {
    expect(restartWatchDecision({ health: { version: "v0.6.2" }, expectedVersion: "0.6.2", elapsed: 0 })).toBe(
      "reload",
    );
    expect(restartWatchDecision({ health: { version: "0.6.2" }, expectedVersion: "v0.6.2", elapsed: 0 })).toBe(
      "reload",
    );
  });

  it("waits on a probe error (health null) — expected while the port is down mid-restart", () => {
    expect(restartWatchDecision({ health: null, expectedVersion: "v0.6.2", elapsed: 5000 })).toBe("wait");
  });

  it("times out once elapsed reaches the bound, even with no health data", () => {
    expect(
      restartWatchDecision({ health: null, expectedVersion: "v0.6.2", elapsed: RESTART_WATCH_TIMEOUT_MS }),
    ).toBe("timeout");
  });

  it("does not time out one tick before the bound", () => {
    expect(
      restartWatchDecision({ health: null, expectedVersion: "v0.6.2", elapsed: RESTART_WATCH_TIMEOUT_MS - 1 }),
    ).toBe("wait");
  });

  it("still times out even if the OLD version keeps answering past the bound", () => {
    expect(
      restartWatchDecision({
        health: { version: "0.6.1" },
        expectedVersion: "v0.6.2",
        elapsed: RESTART_WATCH_TIMEOUT_MS,
      }),
    ).toBe("timeout");
  });

  it("reloads on a journal-reported 'done' even before/without a matching health version", () => {
    expect(
      restartWatchDecision({ health: null, expectedVersion: "v0.6.2", elapsed: 1000, journalPhase: "done" }),
    ).toBe("reload");
  });

  it("treats a journal-reported rolled_back/failed as an immediate (pre-timeout) failure", () => {
    expect(
      restartWatchDecision({ health: null, expectedVersion: "v0.6.2", elapsed: 1000, journalPhase: "rolled_back" }),
    ).toBe("timeout");
    expect(
      restartWatchDecision({ health: null, expectedVersion: "v0.6.2", elapsed: 1000, journalPhase: "failed" }),
    ).toBe("timeout");
  });

  it("prefers the journal 'done' signal over a stale/mismatched health probe", () => {
    expect(
      restartWatchDecision({
        health: { version: "0.6.1" },
        expectedVersion: "v0.6.2",
        elapsed: 1000,
        journalPhase: "done",
      }),
    ).toBe("reload");
  });
});
