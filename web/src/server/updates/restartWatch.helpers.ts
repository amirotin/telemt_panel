export type RestartWatchStatus = "wait" | "reload" | "timeout";

export interface RestartWatchHealth {
  version: string;
}

export interface RestartWatchInput {
  /** Latest successful GET /api/health response, or null (not fetched yet / the probe errored — expected while the old process is down and the new one hasn't bound the port yet). */
  health: RestartWatchHealth | null;
  expectedVersion: string;
  elapsed: number;
  /**
   * The panel target's newest update-journal entry's phase, from a poll of
   * GET /api/updates taken after the watch started. internal/update/
   * startup.go's ReconcileStartup appends this entry directly to the
   * journal store (`st.AppendUpdateJournal`) — it does NOT go through
   * Engine.transition/publish, so it never reaches the "update" SSE topic
   * at all; polling /api/updates is the only way to observe it.
   */
  journalPhase?: string;
}

// RESTART_WATCH_TIMEOUT_MS bounds how long the watch waits for a live
// process of the expected version before giving up and surfacing a
// failure state with a manual-recovery hint, rather than polling forever.
export const RESTART_WATCH_TIMEOUT_MS = 120_000;

// normalizeVersion mirrors internal/update/semver.go's own normalization
// (TrimPrefix(s, "v")): GET /api/health's version is the ldflags build
// version (no "v" — .github/workflows/release.yml strips it before
// passing VERSION to `make release`), while an update run's version_to is
// the raw GitHub release tag (e.g. "v0.6.2", confirmed live against a
// real /api/updates response) — comparing them without normalizing would
// never match a successful update.
function normalizeVersion(v: string): string {
  return v.replace(/^v/, "");
}

// restartWatchDecision is the pure "is the panel's self-update actually
// done yet" check driving usePanelRestartWatch. Deliberately does NOT
// treat "the health endpoint answered" alone as done:
// internal/update/engine.go publishes the "restarting" phase BEFORE
// issuing the restart operation (transition happens first, the Runner
// call that actually kills/replaces the process happens after), so the
// first several polls after that almost always still hit the OLD process
// — still perfectly healthy, just the wrong version. Reloading on that
// premature signal would spin the page in a restarting→reload→restarting
// loop until the real restart eventually lands. Only a version match, or
// the new process's own ReconcileStartup journal entry reporting "done"
// (see RestartWatchInput.journalPhase's doc comment — never observable via
// SSE), counts as actually done. A ReconcileStartup-reported "rolled_back"/
// "failed" is a definitive negative outcome — further waiting is pointless,
// so it short-circuits straight to the same "timeout" failure state rather
// than inventing a fourth status this task's own contract doesn't ask for.
export function restartWatchDecision({
  health,
  expectedVersion,
  elapsed,
  journalPhase,
}: RestartWatchInput): RestartWatchStatus {
  if (journalPhase === "done") return "reload";
  if (health && normalizeVersion(health.version) === normalizeVersion(expectedVersion)) return "reload";
  if (journalPhase === "rolled_back" || journalPhase === "failed") return "timeout";
  if (elapsed >= RESTART_WATCH_TIMEOUT_MS) return "timeout";
  return "wait";
}
