import type { UpdateRun } from "../../lib/api/generated/types.gen";

export type RestartWatchStatus = "wait" | "reload" | "failed" | "timeout";

export interface RestartWatchInput {
  runID: string;
  expectedVersion: string;
  health: { version: string } | null;
  healthFresh: boolean;
  elapsed: number;
  /** Only a response fetched after this run's watch began belongs here. */
  journal?: Pick<UpdateRun, "run_id" | "phase" | "version_to" | "detail"> | null;
}

export const RESTART_WATCH_TIMEOUT_MS = 120_000;

function normalizeVersion(version: string): string {
  return version.replace(/^v/, "");
}

// Startup reconciliation runs before listeners/TLS are ready, so even a
// matching journal done entry still needs a fresh live health response.
export function restartWatchDecision({ runID, expectedVersion, health, healthFresh, elapsed, journal }: RestartWatchInput): RestartWatchStatus {
  const current = journal?.run_id === runID && normalizeVersion(journal.version_to) === normalizeVersion(expectedVersion);
  if (current && (journal.phase === "rolled_back" || journal.phase === "failed")) return "failed";
  if (healthFresh && health && normalizeVersion(health.version) === normalizeVersion(expectedVersion)) return "reload";
  if (elapsed >= RESTART_WATCH_TIMEOUT_MS) return "timeout";
  return "wait";
}
