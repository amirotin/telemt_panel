import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingChanges,
  getPendingChanges,
  recordPendingChanges,
  resolvePendingChanges,
} from "./pendingChanges";
import type { TelemtConfigPatchResult } from "../../lib/api/generated/types.gen";
import type { StatsSnapshot } from "../../realtime/topics";

function result(overrides: Partial<TelemtConfigPatchResult> = {}): TelemtConfigPatchResult {
  return { revision: "r1", changed: ["general"], ...overrides };
}

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { health: null, summary: null, ready: null, ...overrides };
}

beforeEach(() => {
  clearPendingChanges();
});

describe("recordPendingChanges", () => {
  it("remembers a reload the PATCH did not perform itself", () => {
    recordPendingChanges(result({ runtime_reload_required: true }), 1_000);
    expect(getPendingChanges()).toEqual({ runtimeReload: true, processRestart: false, at: 1_000 });
  });

  // The PATCH's own inline reload already applied it — same rule
  // PatchResultNotice renders by.
  it("remembers nothing when the PATCH reloaded inline", () => {
    recordPendingChanges(
      result({
        runtime_reload_required: true,
        reload: {
          reload_id: 1,
          target_generation: 2,
          config_revision: "r1",
          state: "accepted",
          mode: "drain",
          failure_policy: "rollback",
        },
      }),
      1_000,
    );
    expect(getPendingChanges()).toBeNull();
  });

  it("clears an older record when a later PATCH leaves nothing pending", () => {
    recordPendingChanges(result({ process_restart_required: true }), 1_000);
    recordPendingChanges(result(), 2_000);
    expect(getPendingChanges()).toBeNull();
  });
});

describe("resolvePendingChanges", () => {
  const at = 10_000_000;

  it("keeps a reload pending until one has actually happened", () => {
    const pending = { runtimeReload: true, processRestart: false, at };
    const notYet = resolvePendingChanges(
      pending,
      stats({ last_config_reload_epoch_secs: (at - 60_000) / 1000 }),
      at + 1_000,
    );
    expect(notYet.runtimeReload).toBe(true);

    const done = resolvePendingChanges(
      pending,
      stats({ last_config_reload_epoch_secs: (at + 5_000) / 1000 }),
      at + 10_000,
    );
    expect(done.runtimeReload).toBe(false);
  });

  // A restart re-reads the config file from scratch, so it settles both.
  it("clears both halves once the process has restarted since the PATCH", () => {
    const pending = { runtimeReload: true, processRestart: true, at };
    const now = at + 600_000;
    const resolved = resolvePendingChanges(pending, stats({ uptime_seconds: 60 }), now);
    expect(resolved).toEqual({ runtimeReload: false, processRestart: false });
  });

  it("keeps a restart pending while Telemt has been up since before the PATCH", () => {
    const pending = { runtimeReload: false, processRestart: true, at };
    const resolved = resolvePendingChanges(
      pending,
      stats({ uptime_seconds: 86_400 }),
      at + 60_000,
    );
    expect(resolved.processRestart).toBe(true);
  });

  it("is nothing-pending when nothing was recorded", () => {
    expect(resolvePendingChanges(null, stats())).toEqual({
      runtimeReload: false,
      processRestart: false,
    });
  });

  // Without a stats snapshot there is nothing to rule the record out with,
  // so it stands rather than silently disappearing.
  it("keeps the record when the stats topic has not answered yet", () => {
    const resolved = resolvePendingChanges(
      { runtimeReload: true, processRestart: false, at },
      null,
      at + 1_000,
    );
    expect(resolved.runtimeReload).toBe(true);
  });
});
