import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getHealthOptions, getUpdatesOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import { restartWatchDecision, type RestartWatchStatus } from "./restartWatch.helpers";

const HEALTH_POLL_MS = 2000;
const JOURNAL_POLL_MS = 3000;
// The elapsed-time clock ticks on this cadence — matches the health poll's
// own interval, so "elapsed" stays a reasonably accurate approximation of
// wall-clock time without ever calling Date.now() during render (React's
// purity rule: components/hooks must not call impure functions in their
// render body — see the tick-counter comment below for why this isn't a
// plain `Date.now() - startedAt` computation).
const TICK_MS = HEALTH_POLL_MS;

export interface PanelRestartWatchResult {
  status: RestartWatchStatus;
  /** Resets the timeout window and forces both probes to refetch immediately — the "Повторить проверку" action. */
  retry: () => void;
}

// usePanelRestartWatch polls GET /api/health (does the responding process
// report the update's own version_to?) and GET /api/updates (has
// ReconcileStartup already appended a "done"/"rolled_back"/"failed" journal
// entry for the panel target? — the only way to observe that, since it
// never reaches the "update" SSE topic, see restartWatch.helpers.ts's own
// doc comment) while `active` — meant to be true exactly while the panel's
// own self-update run sits at the "restarting" phase. `restartWatchDecision`
// (pure, tested) turns both signals plus elapsed time into wait/reload/
// timeout; this hook only owns the polling and the elapsed-time clock.
//
// `retry: false` on the health query because cadence is already controlled
// by `refetchInterval` itself — a failed probe (connection refused
// mid-restart) just means "try again in 2s", not something TanStack
// Query's own backoff needs to additionally delay.
export function usePanelRestartWatch(active: boolean, expectedVersion: string): PanelRestartWatchResult {
  // `ticks` is a poll-interval counter, not a Date.now() timestamp diff —
  // React's rules-of-hooks purity check forbids calling an impure function
  // like Date.now() during render (this hook's `elapsed` value is read on
  // every render), so elapsed time is derived from a plain incrementing
  // counter driven by a timer instead. `null` means "not currently
  // watching"; `active`/`!active` transitions reset it via React's
  // documented render-time state-adjustment pattern (matching
  // server/config/useConfigEditor.ts's own precedent) rather than a
  // useEffect body (this project's eslint-plugin-react-hooks config flags
  // synchronous setState there).
  const [ticks, setTicks] = useState<number | null>(null);
  if (active && ticks === null) setTicks(0);
  if (!active && ticks !== null) setTicks(null);

  // The actual ticking happens asynchronously inside setInterval's
  // callback (not synchronously in the effect body), which is the
  // ordinary, unflagged pattern for a timer-driven counter.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTicks((t) => (t === null ? null : t + 1)), TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  const healthQuery = useQuery({
    ...getHealthOptions(),
    enabled: active,
    retry: false,
    refetchInterval: () => (active ? HEALTH_POLL_MS : false),
  });

  const updatesQuery = useQuery({
    ...getUpdatesOptions(),
    enabled: active,
    refetchInterval: () => (active ? JOURNAL_POLL_MS : false),
  });

  const journalPhase = updatesQuery.data?.targets.find((t) => t.target === "panel")?.journal?.[0]?.phase;
  const elapsed = (ticks ?? 0) * TICK_MS;

  const status: RestartWatchStatus = active
    ? restartWatchDecision({ health: healthQuery.data ?? null, expectedVersion, elapsed, journalPhase })
    : "wait";

  function retry() {
    setTicks(0);
    void healthQuery.refetch();
    void updatesQuery.refetch();
  }

  return { status, retry };
}
