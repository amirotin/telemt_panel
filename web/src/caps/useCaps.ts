import { useQuery } from "@tanstack/react-query";
import { getTelemtInfoOptions } from "../lib/api/generated/@tanstack/react-query.gen";

// useCaps exposes GET /api/telemt/info (TelemtInfo: reachable, version,
// capabilities{quota, runtime_edge, reload_api, config_api,
// user_enable_disable, rotate_secret} — 07-telemt-sdk.md §SDK-3) for
// <Gated> checks across the app. staleTime 5 minutes: capabilities only
// change across a Telemt build upgrade/restart, never mid-session, so
// there's no reason to refetch on every tab refocus.
export function useCaps() {
  return useQuery({ ...getTelemtInfoOptions(), staleTime: 5 * 60_000 });
}
