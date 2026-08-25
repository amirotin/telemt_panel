import { useQuery } from "@tanstack/react-query";
import { getHostOptions } from "../lib/api/generated/@tanstack/react-query.gen";

// useHostInfo exposes GET /api/host (01-host-matrix.md): service manager,
// log source, privileges mode, capability flags and manual_commands. The
// Logs tab uses caps.log_tail/log_stream + manual_commands to pick between
// live streaming, the tail-only fallback, and the fully-gated state (Task 7
// deliverable B). staleTime mirrors useCaps.ts's reasoning: this only
// changes across a host reconfiguration or restart, never mid-session.
export function useHostInfo() {
  return useQuery({ ...getHostOptions(), staleTime: 5 * 60_000 });
}
