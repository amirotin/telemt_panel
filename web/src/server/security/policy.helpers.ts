import type { TelemtAccessPolicy, TelemtAccessPolicyPatch } from "../../lib/api/generated/types.gen";

export type PolicyDraft = Record<keyof TelemtAccessPolicy, string>;
export const policyNumbers = ["user_max_tcp_conns_global_each", "user_max_unique_ips_global_each", "user_max_unique_ips_window_secs"] as const;

export function policyDraft(value: TelemtAccessPolicy): PolicyDraft {
  return {
    user_max_tcp_conns_global_each: String(value.user_max_tcp_conns_global_each),
    user_max_unique_ips_global_each: String(value.user_max_unique_ips_global_each),
    user_max_unique_ips_window_secs: String(value.user_max_unique_ips_window_secs),
    user_max_unique_ips_mode: value.user_max_unique_ips_mode,
    cidr_rate_limits: Object.entries(value.cidr_rate_limits).map(([cidr, rate]) => `${cidr} ${rate.up_bps} ${rate.down_bps}`).join("\n"),
  };
}

function integer(text: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 0) throw new Error("integer");
  return value;
}

function rules(text: string): Map<string, [string, string]> {
  const result = new Map<string, [string, string]>();
  for (const line of text.split("\n").map(value => value.trim()).filter(Boolean)) {
    const [cidr, up, down, ...extra] = line.split(/\s+/);
    if (!cidr?.includes("/") || up === undefined || down === undefined || extra.length || result.has(cidr)) throw new Error("cidr");
    result.set(cidr, [up, down]);
  }
  return result;
}

// Build sparse changes so untouched u64 values never round-trip through JS numbers.
export function policyPatch(base: PolicyDraft, draft: PolicyDraft): TelemtAccessPolicyPatch {
  const patch: TelemtAccessPolicyPatch = {};
  for (const key of policyNumbers) if (draft[key] !== base[key]) patch[key] = integer(draft[key].trim());
  if (draft.user_max_unique_ips_mode !== base.user_max_unique_ips_mode) {
    if (!["active_window", "time_window", "combined"].includes(draft.user_max_unique_ips_mode)) throw new Error("mode");
    patch.user_max_unique_ips_mode = draft.user_max_unique_ips_mode as TelemtAccessPolicy["user_max_unique_ips_mode"];
  }
  if (draft.cidr_rate_limits !== base.cidr_rate_limits) {
    const before = rules(base.cidr_rate_limits), after = rules(draft.cidr_rate_limits);
    if (after.size === 0 && before.size > 0) patch.cidr_rate_limits = null;
    else {
      const changed: NonNullable<TelemtAccessPolicyPatch["cidr_rate_limits"]> = {};
      for (const [cidr, [up, down]] of after) {
        const old = before.get(cidr);
        if (old?.[0] === up && old?.[1] === down) continue;
        changed[cidr] = { up_bps: integer(up), down_bps: integer(down) };
      }
      for (const cidr of before.keys()) if (!after.has(cidr)) changed[cidr] = null;
      if (Object.keys(changed).length) patch.cidr_rate_limits = changed;
    }
  }
  return patch;
}
