import type { SecurityPosture, SecurityWhitelist } from "../../realtime/topics";

export type ApiProtectionKind = "local" | "layered" | "whitelist" | "auth" | "read_only" | "exposed" | "unknown";

export function isLoopbackCidr(value: string): boolean {
  const parts = value.trim().toLowerCase().split("/");
  if (parts.length > 2) return false;
  const address = (parts[0] ?? "").replace(/^\[|\]$/g, "");
  const rawPrefix = parts[1];

  if (address === "localhost") return rawPrefix === undefined;
  if (address === "::1") {
    const prefix = rawPrefix === undefined ? 128 : Number(rawPrefix);
    return Number.isInteger(prefix) && prefix === 128;
  }

  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const prefix = rawPrefix === undefined ? 32 : Number(rawPrefix);
  return Number.isInteger(prefix) && prefix >= 8 && prefix <= 32 && octets[0] === 127;
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
