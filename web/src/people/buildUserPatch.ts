import type { UserCreate, UserPatch } from "../lib/api/generated/types.gen";

// LimitFieldState is the explicit three-state UI control for every optional
// limit on the edit form (06-ui.md: "Трёхзначная семантика лимитов (не
// менять / снять / установить) отражается UI-переключателем, а не магией
// «0»"). It mirrors JSON Merge Patch exactly:
//   "keep"  -> the wire key is omitted entirely (Telemt: leave unchanged)
//   "clear" -> the wire key is present with value null (Telemt: remove the limit)
//   "set"   -> the wire key is present with the given value (Telemt: set it)
export type LimitFieldState<T> = { mode: "keep" } | { mode: "clear" } | { mode: "set"; value: T };

export interface UserPatchFormState {
  userAdTag: LimitFieldState<string>;
  maxTcpConns: LimitFieldState<number>;
  maxUniqueIps: LimitFieldState<number>;
  dataQuotaBytes: LimitFieldState<number>;
  expirationRfc3339: LimitFieldState<string>;
  rateLimitUpBps: LimitFieldState<number>;
  rateLimitDownBps: LimitFieldState<number>;
}

// keepAll is the neutral starting point for an edit form: every field
// "keep" (patch would be an empty object — nothing changes) until the
// admin actively switches a field to clear/set.
export function keepAllPatchFields(): UserPatchFormState {
  return {
    userAdTag: { mode: "keep" },
    maxTcpConns: { mode: "keep" },
    maxUniqueIps: { mode: "keep" },
    dataQuotaBytes: { mode: "keep" },
    expirationRfc3339: { mode: "keep" },
    rateLimitUpBps: { mode: "keep" },
    rateLimitDownBps: { mode: "keep" },
  };
}

function assign(
  patch: Record<string, unknown>,
  key: string,
  state: LimitFieldState<unknown>,
): void {
  if (state.mode === "keep") return; // absent from `patch` -> omitted on the wire
  patch[key] = state.mode === "clear" ? null : state.value;
}

// buildUserPatch is the pure serializer PATCH /api/users/{username} goes
// through: exhaustively tested (buildUserPatch.test.ts) so "omitted" vs
// "null" vs "value" can never regress into JSON.stringify accidentally
// dropping/keeping a key. `secret` is deliberately not a field here — the
// brief and 07-telemt-sdk.md both make secret rotation a separate action
// (rotate-secret), not part of this form/patch.
export function buildUserPatch(form: UserPatchFormState): UserPatch {
  const patch: Record<string, unknown> = {};
  assign(patch, "user_ad_tag", form.userAdTag);
  assign(patch, "max_tcp_conns", form.maxTcpConns);
  assign(patch, "max_unique_ips", form.maxUniqueIps);
  assign(patch, "data_quota_bytes", form.dataQuotaBytes);
  assign(patch, "expiration_rfc3339", form.expirationRfc3339);
  assign(patch, "rate_limit_up_bps", form.rateLimitUpBps);
  assign(patch, "rate_limit_down_bps", form.rateLimitDownBps);
  return patch as UserPatch;
}

// --- create ---

export interface UserCreateFormState {
  username: string;
  secret: string;
  enabled: boolean;
  userAdTag?: string;
  maxTcpConns?: number;
  maxUniqueIps?: number;
  dataQuotaBytes?: number;
  expirationRfc3339?: string;
  rateLimitUpBps?: number;
  rateLimitDownBps?: number;
}

// buildUserCreateBody is POST /api/users' body serializer. Create has no
// "existing value" to keep, so its optional fields are simple presence:
// unset/empty means "unlimited", nothing to omit-vs-null about.
export function buildUserCreateBody(form: UserCreateFormState): UserCreate {
  const body: UserCreate = {
    username: form.username,
    secret: form.secret,
    enabled: form.enabled,
  };
  if (form.userAdTag) body.user_ad_tag = form.userAdTag;
  if (form.maxTcpConns !== undefined) body.max_tcp_conns = form.maxTcpConns;
  if (form.maxUniqueIps !== undefined) body.max_unique_ips = form.maxUniqueIps;
  if (form.dataQuotaBytes !== undefined) body.data_quota_bytes = form.dataQuotaBytes;
  if (form.expirationRfc3339) body.expiration_rfc3339 = form.expirationRfc3339;
  if (form.rateLimitUpBps !== undefined) body.rate_limit_up_bps = form.rateLimitUpBps;
  if (form.rateLimitDownBps !== undefined) body.rate_limit_down_bps = form.rateLimitDownBps;
  return body;
}
