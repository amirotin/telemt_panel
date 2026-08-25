import { describe, expect, it } from "vitest";
import { computeSecurityPostureView } from "./securityPosture.helpers";
import type { SecurityPosture, SecurityWhitelist } from "../../realtime/topics";

function posture(overrides: Partial<SecurityPosture> = {}): SecurityPosture {
  return {
    api_read_only: false,
    api_whitelist_enabled: true,
    api_whitelist_entries: 3,
    api_auth_header_enabled: true,
    proxy_protocol_enabled: false,
    log_level: "info",
    telemetry_core_enabled: true,
    telemetry_user_enabled: false,
    telemetry_me_level: "basic",
    ...overrides,
  };
}

describe("computeSecurityPostureView", () => {
  it("falls back to posture's own entry count when whitelist hasn't loaded", () => {
    const view = computeSecurityPostureView(posture(), null);
    expect(view.whitelistEntries).toBe(3);
  });

  it("prefers the whitelist payload's own count when loaded", () => {
    const whitelist: SecurityWhitelist = { generated_at_epoch_secs: 0, enabled: true, entries_total: 5, entries: ["a", "b", "c", "d", "e"] };
    const view = computeSecurityPostureView(posture(), whitelist);
    expect(view.whitelistEntries).toBe(5);
  });

  it("passes through the rest of posture as-is", () => {
    const view = computeSecurityPostureView(posture({ api_read_only: true, log_level: "debug" }), null);
    expect(view.readOnly).toBe(true);
    expect(view.logLevel).toBe("debug");
    expect(view.authHeaderEnabled).toBe(true);
  });
});
