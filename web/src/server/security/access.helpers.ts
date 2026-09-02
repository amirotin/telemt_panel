import type { SecurityPosture, SecurityWhitelist } from "../../realtime/topics";

export type ApiProtectionKind = "local" | "layered" | "whitelist" | "auth" | "read_only" | "exposed" | "unknown";

export function isLoopbackCidr(value: string): boolean {
  const address = value.trim().toLowerCase().split("/")[0]?.replace(/^\[|\]$/g, "") ?? "";
  return address === "::1" || address === "localhost" || /^127(?:\.|$)/.test(address);
}

// Assess the complete access chain: auth-header=false is not a warning when
// an enabled whitelist confines the API to loopback, while read-write with
// neither barrier is genuinely exposed.
export function apiProtectionKind(posture: SecurityPosture | null | undefined, whitelist: SecurityWhitelist | null | undefined): ApiProtectionKind {
  if (!posture) return "unknown";
  if (posture.api_whitelist_enabled && posture.api_auth_header_enabled) return "layered";
  if (posture.api_whitelist_enabled) {
    if (whitelist?.entries.length && whitelist.entries.every(isLoopbackCidr)) return "local";
    return "whitelist";
  }
  if (posture.api_auth_header_enabled) return "auth";
  if (posture.api_read_only) return "read_only";
  return "exposed";
}
