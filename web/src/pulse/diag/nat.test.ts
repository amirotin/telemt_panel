import { describe, expect, it } from "vitest";
import type { RuntimeNatStun } from "../../realtime/topics";
import { natMechanismState } from "./nat.helpers";

function snapshot(overrides: Partial<RuntimeNatStun> = {}): RuntimeNatStun {
  return {
    flags: {
      nat_probe_enabled: true,
      nat_probe_disabled_runtime: false,
      nat_probe_attempts: 0,
    },
    servers: { configured: [], live: [], live_total: 0 },
    reflection: { v4: { addr: "203.0.113.1:443", age_secs: 120 } },
    ...overrides,
  };
}

describe("natMechanismState", () => {
  it("uses reflection freshness rather than the transient responder count", () => {
    expect(natMechanismState(snapshot())).toBe("fresh");
  });

  it("reports delayed refresh only when stale cache has a failure signal", () => {
    expect(
      natMechanismState(
        snapshot({
          flags: {
            nat_probe_enabled: true,
            nat_probe_disabled_runtime: false,
            nat_probe_attempts: 3,
          },
          reflection: { v4: { addr: "203.0.113.1:443", age_secs: 610 } },
        }),
      ),
    ).toBe("delayed");
    expect(
      natMechanismState(
        snapshot({ reflection: { v4: { addr: "203.0.113.1:443", age_secs: 610 } } }),
      ),
    ).toBe("stale");
  });

  it("distinguishes an initial absence from a failed discovery", () => {
    expect(natMechanismState(snapshot({ reflection: {} }))).toBe("pending");
    expect(natMechanismState(snapshot({ reflection: {}, stun_backoff_remaining_ms: 5_000 }))).toBe(
      "missing",
    );
  });

  it("keeps a configured or runtime-disabled probe neutral", () => {
    expect(
      natMechanismState(
        snapshot({
          flags: {
            nat_probe_enabled: false,
            nat_probe_disabled_runtime: false,
            nat_probe_attempts: 7,
          },
          reflection: {},
        }),
      ),
    ).toBe("disabled");
    expect(
      natMechanismState(
        snapshot({
          flags: {
            nat_probe_enabled: true,
            nat_probe_disabled_runtime: true,
            nat_probe_attempts: 7,
          },
        }),
      ),
    ).toBe("disabled");
  });
});
