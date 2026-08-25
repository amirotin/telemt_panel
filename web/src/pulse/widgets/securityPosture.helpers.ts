import type { SecurityPosture, SecurityWhitelist } from "../../realtime/topics";

export interface SecurityPostureView {
  readOnly: boolean;
  whitelistEnabled: boolean;
  whitelistEntries: number;
  authHeaderEnabled: boolean;
  proxyProtocolEnabled: boolean;
  logLevel: string;
  telemetryCoreEnabled: boolean;
  telemetryUserEnabled: boolean;
}

// computeSecurityPostureView folds posture + whitelist into one view —
// posture.api_whitelist_entries and whitelist.entries_total should agree
// (same underlying count from two different endpoints), but the widget
// prefers the dedicated whitelist payload's own count when it's loaded,
// falling back to posture's own copy when whitelist hasn't come in yet.
export function computeSecurityPostureView(
  posture: SecurityPosture,
  whitelist: SecurityWhitelist | null,
): SecurityPostureView {
  return {
    readOnly: posture.api_read_only,
    whitelistEnabled: posture.api_whitelist_enabled,
    whitelistEntries: whitelist?.entries_total ?? posture.api_whitelist_entries,
    authHeaderEnabled: posture.api_auth_header_enabled,
    proxyProtocolEnabled: posture.proxy_protocol_enabled,
    logLevel: posture.log_level,
    telemetryCoreEnabled: posture.telemetry_core_enabled,
    telemetryUserEnabled: posture.telemetry_user_enabled,
  };
}
