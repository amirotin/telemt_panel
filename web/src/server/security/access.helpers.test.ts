import { describe, expect, it } from "vitest";
import type { SecurityPosture, SecurityWhitelist } from "../../realtime/topics";
import { apiProtectionKind, isLoopbackCidr } from "./access.helpers";

const posture = (overrides: Partial<SecurityPosture> = {}): SecurityPosture => ({
  api_read_only: false,
  api_whitelist_enabled: true,
  api_whitelist_entries: 1,
  api_auth_header_enabled: false,
  proxy_protocol_enabled: true,
  log_level: "silent",
  telemetry_core_enabled: true,
  telemetry_user_enabled: true,
  telemetry_me_level: "normal",
  ...overrides,
});

const whitelist = (entries: string[]): SecurityWhitelist => ({
  generated_at_epoch_secs: 1,
  enabled: true,
  entries_total: entries.length,
  entries,
});

describe("server security access assessment", () => {
  it("recognizes IPv4, IPv6 and named loopback entries", () => {
    expect(isLoopbackCidr("127.0.0.1/32")).toBe(true);
    expect(isLoopbackCidr("127.12.1.0/24")).toBe(true);
    expect(isLoopbackCidr("::1/128")).toBe(true);
    expect(isLoopbackCidr("localhost")).toBe(true);
    expect(isLoopbackCidr("10.0.0.0/8")).toBe(false);
  });

  it("treats a loopback whitelist without auth header as protected local access", () => {
    expect(apiProtectionKind(posture(), whitelist(["127.0.0.1/32"]))).toBe("local");
  });

  it("distinguishes layered, network-only, secret-only and read-only modes", () => {
    expect(apiProtectionKind(posture({ api_auth_header_enabled: true }), whitelist(["10.20.0.0/24"]))).toBe("layered");
    expect(apiProtectionKind(posture(), whitelist(["10.20.0.0/24"]))).toBe("whitelist");
    expect(apiProtectionKind(posture({ api_whitelist_enabled: false, api_auth_header_enabled: true }), null)).toBe("auth");
    expect(apiProtectionKind(posture({ api_whitelist_enabled: false, api_read_only: true }), null)).toBe("read_only");
  });

  it("marks writable API with no barriers as exposed", () => {
    expect(apiProtectionKind(posture({ api_whitelist_enabled: false }), null)).toBe("exposed");
    expect(apiProtectionKind(null, null)).toBe("unknown");
  });
});
