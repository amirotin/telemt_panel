export type ReloadMode = "none" | "instant" | "drain";

export interface ReloadPolicyState {
  mode: ReloadMode;
  timeoutSecs: number;
}

export const DEFAULT_RELOAD_POLICY: ReloadPolicyState = { mode: "none", timeoutSecs: 30 };

export interface PatchReloadQuery {
  reload?: "instant" | "drain";
  timeout_secs?: number;
}

// toPatchReloadQuery builds PATCH /api/telemt/config's optional
// reload/timeout_secs query from the reload-policy picker's state —
// "none" sends no reload query at all (07-telemt-sdk.md §Config:
// PatchConfig's ReloadQuery zero value means "patch only, no inline
// reload" — the admin applies the config and reloads separately, or on a
// later PATCH).
export function toPatchReloadQuery(policy: ReloadPolicyState): PatchReloadQuery {
  if (policy.mode === "none") return {};
  const query: PatchReloadQuery = { reload: policy.mode };
  if (policy.mode === "drain") query.timeout_secs = policy.timeoutSecs;
  return query;
}
