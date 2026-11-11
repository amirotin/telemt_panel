import type { TelemtConfigState, TelemtConfigPatchResult } from "../../lib/api/generated/types.gen";

const FULL_SECTIONS = ["general", "network", "server", "timeouts", "censorship", "upstreams", "dc_overrides", "web", "access", "logging", "root"];
export function nativeStateMatches(state: TelemtConfigState | undefined, revision?: string): boolean {
  return !!state && state.runtime_sample_current === true && state.desired_status === "valid"
    && typeof state.desired_revision === "string" && state.revision === state.desired_revision
    && (!revision || state.desired_revision === revision)
    && state.comparison?.status === "published_match" && state.comparison.truncated === false
    && ["pending_paths", "watcher_pending_paths", "generation_pending_paths", "process_deferred_paths"].every((key) => Array.isArray(state.comparison[key]) && state.comparison[key].length === 0)
    && state.sections?.length === FULL_SECTIONS.length && FULL_SECTIONS.every((section) => state.sections!.includes(section))
    && !state.desired_error && !state.projection_error;
}

export function nativeStatePaths(state: TelemtConfigState | undefined, key: string): string[] {
  const value = state?.comparison?.[key];
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : [];
}

export interface NativeConfigPublication {
  state?: TelemtConfigState;
  updatedAt: number;
  failed: boolean;
}

export function resolvePublishedPatchResult(result: TelemtConfigPatchResult, publication: NativeConfigPublication | undefined, submittedAt: number): TelemtConfigPatchResult {
  if (!publication || publication.failed || publication.updatedAt < submittedAt || !nativeStateMatches(publication.state, result.revision)) return result;
  return { ...result, runtime_reload_required: false, process_restart_required: false };
}
