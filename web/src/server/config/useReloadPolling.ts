import { useQuery } from "@tanstack/react-query";
import { getTelemtReloadStatusOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import { isTerminalReloadState } from "./reloadStatus.helpers";

// useReloadPolling polls GET /api/telemt/reload/{id} (07-telemt-sdk.md:
// "статус: accepted→preparing→activating→draining→succeeded|rolled_back|
// failed; хранится 32 последних") until the reload reaches a terminal
// state, then stops — same refetchInterval-driven pattern as
// pulse/useHistorySeries.ts, no hand-rolled effect/timer needed.
// `reloadId === null` means "nothing to poll" (disabled query, never fires).
export function useReloadPolling(reloadId: number | null) {
  return useQuery({
    ...getTelemtReloadStatusOptions({ path: { id: reloadId ?? 0 } }),
    enabled: reloadId !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state && isTerminalReloadState(state) ? false : 1500;
    },
  });
}
