import { validateTelemtConfig } from "../../lib/api/generated/sdk.gen";
import type { TelemtConfigValidation, TelemtConfigPatchResult } from "../../lib/api/generated/types.gen";
import { apiErrorCode } from "../../people/apiError";
import { toPatchReloadQuery, type ReloadPolicyState } from "./reloadPolicy";

export interface ConfigPreflight {
  revision: string;
  runtimeMatch?: string;
  validation?: TelemtConfigValidation;
  policy: ReloadPolicyState;
}

// Discovery can lag an upgrade or temporarily fail. Only the optional
// endpoint's explicit absence permits the established local preview.
export async function preflightConfig(revision: string, sections: Record<string, unknown>, policy: ReloadPolicyState): Promise<ConfigPreflight> {
  try {
    const { data } = await validateTelemtConfig({ headers: { "If-Match": revision }, query: toPatchReloadQuery(policy), body: { sections }, throwOnError: true });
    if (!validationMatches(data, revision)) throw { code: "telemt_api_error" };
    return { revision: data.revision ?? data.base_revision, runtimeMatch: data.runtime.runtime_match, validation: data, policy: { ...policy } };
  } catch (error) {
    if (apiErrorCode(error) === "capability_absent") return { revision, policy: { ...policy } };
    throw error;
  }
}

export function validationMatches(validation: TelemtConfigValidation | undefined, revision: string): validation is TelemtConfigValidation {
  return !!validation && validation.valid === true && validation.base_revision === revision
    && (validation.revision === undefined || validation.revision === revision)
    && typeof validation.runtime?.runtime_match === "string" && validation.runtime.runtime_match.trim().length > 0
    && Array.isArray(validation.changed_paths) && Array.isArray(validation.normalization_effects)
    && Array.isArray(validation.warnings) && !!validation.apply
    && Array.isArray(validation.apply.watcher_paths) && Array.isArray(validation.apply.generation_paths)
    && Array.isArray(validation.apply.process_restart_paths);
}

export function nativePatchResult(result: TelemtConfigPatchResult, validation?: TelemtConfigValidation): TelemtConfigPatchResult {
  if (!validation) return result;
  return { ...result, runtime_reload_required: validation.apply.generation_paths.length > 0 && result.runtime_reload_required, process_restart_required: validation.apply.process_restart_required || result.process_restart_required };
}
