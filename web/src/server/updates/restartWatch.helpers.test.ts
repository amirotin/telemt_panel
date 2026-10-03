import { describe, expect, it } from "vitest";
import { RESTART_WATCH_TIMEOUT_MS, restartWatchDecision } from "./restartWatch.helpers";

const watching = {
  runID: "current",
  health: null,
  healthFresh: false,
  expectedVersion: "v1.0.0-rc.2",
  elapsed: 0,
};

describe("restartWatchDecision", () => {
  it("waits while a fresh probe still reaches the old process", () => {
    expect(restartWatchDecision({ ...watching, health: { version: "1.0.0-rc.1" }, healthFresh: true })).toBe("wait");
  });

  it("ignores a matching health response cached before this watch", () => {
    expect(restartWatchDecision({ ...watching, health: { version: "1.0.0-rc.2" } })).toBe("wait");
  });

  it("reloads once a fresh probe reaches the expected version", () => {
    expect(restartWatchDecision({ ...watching, health: { version: "1.0.0-rc.2" }, healthFresh: true })).toBe("reload");
  });

  it("normalizes a leading v on either health or the expected version", () => {
    expect(restartWatchDecision({ ...watching, health: { version: "v1.0.0-rc.2" }, expectedVersion: "1.0.0-rc.2", healthFresh: true })).toBe("reload");
  });

  it.each(["done", "rolled_back", "failed"] as const)("ignores another run's %s journal entry", (phase) => {
    const input = { ...watching, journal: { run_id: "previous", phase, version_to: "v1.0.0-rc.2" } };
    expect(restartWatchDecision(input)).toBe("wait");
  });

  it("ignores a journal entry with the wrong destination version", () => {
    const input = { ...watching, journal: { run_id: "current", phase: "failed" as const, version_to: "v1.0.0-rc.1" } };
    expect(restartWatchDecision(input)).toBe("wait");
  });

  it("waits for live health after startup reports done", () => {
    const input = { ...watching, journal: { run_id: "current", phase: "done" as const, version_to: "v1.0.0-rc.2" } };
    expect(restartWatchDecision(input)).toBe("wait");
  });

  it.each(["rolled_back", "failed"] as const)("retains a current-run %s outcome rather than a timeout", (phase) => {
    const input = { ...watching, journal: { run_id: "current", phase, version_to: "v1.0.0-rc.2", detail: "restart failed" } };
    expect(restartWatchDecision(input)).toBe("failed");
  });

  it("does not hide a current-run failure behind matching health", () => {
    const input = { ...watching, health: { version: "1.0.0-rc.2" }, healthFresh: true, journal: { run_id: "current", phase: "failed" as const, version_to: "v1.0.0-rc.2" } };
    expect(restartWatchDecision(input)).toBe("failed");
  });

  it("waits through probe errors until the time bound", () => {
    expect(restartWatchDecision({ ...watching, elapsed: RESTART_WATCH_TIMEOUT_MS - 1 })).toBe("wait");
    expect(restartWatchDecision({ ...watching, elapsed: RESTART_WATCH_TIMEOUT_MS })).toBe("timeout");
  });
});
