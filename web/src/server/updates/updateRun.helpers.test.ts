import { describe, expect, it } from "vitest";
import type { UpdateRun } from "../../lib/api/generated/types.gen";
import { selectUpdateRun } from "./updateRun.helpers";

function run(run_id: string, phase: UpdateRun["phase"], started_at: string, detail?: string): UpdateRun {
  return { target: "panel", run_id, phase, started_at, version_to: "v1.0.0-rc.2", detail };
}

const previous = run("previous", "failed", "2026-10-02T10:00:00Z", "previous error");
const current = run("current", "restarting", "2026-10-03T10:00:00Z");

describe("selectUpdateRun", () => {
  it("ignores a previous failure event when REST has a newer active run", () => {
    expect(selectUpdateRun({ target: "panel", active_run: current, journal: [previous] }, previous)).toEqual(current);
  });

  it("accepts a new SSE run while REST still has the previous run", () => {
    expect(selectUpdateRun({ target: "panel", active_run: previous, journal: [previous] }, current)).toEqual(current);
  });

  it("accepts newer current-run progress before the REST snapshot catches up", () => {
    const checking = { ...current, phase: "checking" as const };
    expect(selectUpdateRun({ target: "panel", active_run: checking, journal: [checking] }, current)).toEqual(current);
  });

  it.each(["done", "failed", "rolled_back"] as const)("retains persisted %s over stale current-run progress", (phase) => {
    const finished = run("current", phase, "2026-10-03T10:00:05Z", "current outcome detail");
    expect(selectUpdateRun({ target: "panel", journal: [finished, current] }, current)).toEqual(finished);
  });

  it("retains a current failure after restart without any SSE event", () => {
    const failed = run("current", "failed", "2026-10-03T10:00:05Z", "restart failed: permission denied");
    expect(selectUpdateRun({ target: "panel", journal: [failed] }, null)?.detail).toBe("restart failed: permission denied");
  });

  it("does not move backward from rollback when REST still shows restarting", () => {
    const rollingBack = { ...current, phase: "rolling_back" as const, detail: "restart failed" };
    expect(selectUpdateRun({ target: "panel", active_run: current, journal: [current] }, rollingBack)).toEqual(rollingBack);
  });

  it("ignores another target's event", () => {
    expect(selectUpdateRun({ target: "panel", journal: [current] }, { ...current, target: "telemt" })).toEqual(current);
  });
});
