import type { TelemtConfigPatchResult } from "../../lib/api/generated/types.gen";
import type { StatsSnapshot } from "../../realtime/topics";

// A config PATCH can leave Telemt running something other than what its
// config file now says: `runtime_reload_required` means a reload has to be
// asked for, `process_restart_required` means some fields only take effect
// on the next process start (07-telemt-sdk.md §Config).
//
// Telemt reports that ONLY in the response to the PATCH (and in a reload's
// status) — GET /v1/system/info exposes no "you have unapplied changes"
// flag — so a dashboard opened afterwards has no way to learn it from the
// API. The panel therefore remembers the last such answer per device and
// works out for itself whether it still applies: a reload timestamp newer
// than the PATCH clears the reload half, and a process start newer than the
// PATCH (now − uptime) clears the restart half. Nothing is remembered when
// the PATCH left nothing pending.
export interface PendingConfigChanges {
  runtimeReload: boolean;
  processRestart: boolean;
  revision?: string;
  /** Epoch ms at which the PATCH that produced these returned. */
  at: number;
  reloadAt?: number;
  restartAt?: number;
}

const STORAGE_KEY = "telemt-panel:pending-config:v1";

/**
 * Uptime is sampled at Telemt's own cadence and travels through a poll, so
 * "the process started before the PATCH" is only ever approximate. A few
 * seconds of slack keeps a restart that really did happen from reading as
 * still-pending forever.
 */
const START_TIME_SLACK_MS = 10_000;

export function getPendingChanges(): PendingConfigChanges | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const v = parsed as Record<string, unknown>;
    const at = v["at"];
    if (typeof at !== "number") return null;
    return {
      runtimeReload: v["runtimeReload"] === true,
      processRestart: v["processRestart"] === true,
      at,
      ...(typeof v["reloadAt"] === "number" ? { reloadAt: v["reloadAt"] } : {}),
      ...(typeof v["restartAt"] === "number" ? { restartAt: v["restartAt"] } : {}),
      ...(typeof v["revision"] === "string" ? { revision: v["revision"] } : {}),
    };
  } catch {
    // localStorage unavailable or garbage JSON — nothing is pending as far
    // as this device can tell.
    return null;
  }
}

export function clearPendingChanges(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort — see getPendingChanges.
  }
}

// recordPendingChanges is called with every successful PATCH result. A
// runtime reload the PATCH itself started (`result.reload`) is not pending —
// same rule PatchResultNotice renders by.
export function recordPendingChanges(
  result: TelemtConfigPatchResult,
  now: number = Date.now(),
): void {
  const previous = getPendingChanges();
  const reloadAt = result.reload ? undefined : result.runtime_reload_required ? now
    : previous?.runtimeReload ? previous.reloadAt ?? previous.at : undefined;
  const restartAt = result.process_restart_required ? now
    : previous?.processRestart ? previous.restartAt ?? previous.at : undefined;
  const runtimeReload = reloadAt !== undefined;
  const processRestart = restartAt !== undefined;
  if (!runtimeReload && !processRestart) {
    clearPendingChanges();
    return;
  }
  try {
    const payload: PendingConfigChanges = { runtimeReload, processRestart, at: now, revision: result.revision };
    if (runtimeReload && reloadAt !== now) payload.reloadAt = reloadAt;
    if (processRestart && restartAt !== now) payload.restartAt = restartAt;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort — the banner simply won't mention it.
  }
}

export interface ResolvedPendingChanges {
  runtimeReload: boolean;
  processRestart: boolean;
}

const NOTHING_PENDING: ResolvedPendingChanges = {
  runtimeReload: false,
  processRestart: false,
};

// resolvePendingChanges answers "does what we remembered still apply?"
// against the live stats topic. Without a stats snapshot nothing can be
// ruled out, so what was remembered stands.
export function resolvePendingChanges(
  pending: PendingConfigChanges | null,
  stats: StatsSnapshot | null,
  now: number = Date.now(),
): ResolvedPendingChanges {
  if (!pending) return NOTHING_PENDING;

  const reloadedAt = stats?.last_config_reload_epoch_secs;
  const reloadedSince = typeof reloadedAt === "number" && reloadedAt * 1000 >= (pending.reloadAt ?? pending.at);

  const uptime = stats?.uptime_seconds ?? stats?.summary?.uptime_seconds;
  const startedAt = typeof uptime === "number" ? now - uptime * 1000 : null;
  const restartedSince = (at: number) => startedAt !== null && startedAt >= at - START_TIME_SLACK_MS;

  return {
    // A process restart loads the config file from scratch, so it settles
    // the reload half too.
    runtimeReload: pending.runtimeReload && !reloadedSince && !restartedSince(pending.reloadAt ?? pending.at),
    processRestart: pending.processRestart && !restartedSince(pending.restartAt ?? pending.at),
  };
}
