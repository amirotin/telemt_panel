import { useQuery } from "@tanstack/react-query";
import { getHealthOptions } from "../../lib/api/generated/@tanstack/react-query.gen";

// usePanelRestartWatch polls GET /api/health while `active` — meant to be
// true exactly while the panel's own self-update run sits at the
// "restarting" phase. The SSE connection necessarily drops the instant the
// panel process itself restarts (03-update-engine.md's journal section:
// self-update is only confirmed by a live NEW process), so there is
// nothing left to subscribe to; polling /api/health every 2s is the only
// way to know the new process has come back up. `retry: false` because
// cadence is already controlled by `refetchInterval` itself — a failed
// probe (connection refused mid-restart) just means "try again in 2s",
// not something TanStack Query's own backoff needs to additionally delay.
export function usePanelRestartWatch(active: boolean) {
  return useQuery({
    ...getHealthOptions(),
    enabled: active,
    retry: false,
    refetchInterval: (query) => (query.state.data ? false : 2000),
  });
}
