import { describe, expect, it } from "vitest";
import { postureBadges } from "./posture.helpers";
import type { SecurityPosture } from "../../realtime/topics";
import { ru as s } from "../../i18n";

function posture(overrides: Partial<SecurityPosture>): SecurityPosture {
  return {
    api_read_only: false,
    api_whitelist_enabled: false,
    api_whitelist_entries: 0,
    api_auth_header_enabled: false,
    proxy_protocol_enabled: false,
    log_level: "info",
    telemetry_core_enabled: false,
    telemetry_user_enabled: false,
    telemetry_me_level: "off",
    ...overrides,
  };
}

describe("postureBadges", () => {
  it("marks whitelist/auth-header on as ok, off as warn", () => {
    const on = postureBadges(posture({ api_whitelist_enabled: true, api_auth_header_enabled: true }), s);
    expect(on.find((b) => b.key === "api_whitelist_enabled")?.state).toBe("ok");
    expect(on.find((b) => b.key === "api_auth_header_enabled")?.state).toBe("ok");

    const off = postureBadges(posture({}), s);
    expect(off.find((b) => b.key === "api_whitelist_enabled")?.state).toBe("warn");
    expect(off.find((b) => b.key === "api_auth_header_enabled")?.state).toBe("warn");
  });

  it("renders read_only/proxy_protocol/telemetry as neutral muted informational rows", () => {
    const badges = postureBadges(posture({ api_read_only: true, proxy_protocol_enabled: true }), s);
    expect(badges.find((b) => b.key === "api_read_only")?.state).toBe("muted");
    expect(badges.find((b) => b.key === "proxy_protocol_enabled")?.state).toBe("muted");
    expect(badges.find((b) => b.key === "telemetry_core_enabled")?.state).toBe("muted");
    expect(badges.find((b) => b.key === "telemetry_user_enabled")?.state).toBe("muted");
  });

  it("returns exactly one badge per known posture flag", () => {
    expect(postureBadges(posture({}), s)).toHaveLength(6);
  });
});
