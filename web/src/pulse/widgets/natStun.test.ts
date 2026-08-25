import { describe, expect, it } from "vitest";
import { computeNatStunView } from "./natStun.helpers";
import type { RuntimeNatStun } from "../../realtime/topics";

function nat(overrides: Partial<RuntimeNatStun> = {}): RuntimeNatStun {
  return {
    flags: { nat_probe_enabled: true, nat_probe_disabled_runtime: false, nat_probe_attempts: 3 },
    servers: { configured: ["stun1", "stun2"], live: ["stun1"], live_total: 1 },
    reflection: {},
    ...overrides,
  };
}

describe("computeNatStunView", () => {
  it("reads probe/server counters", () => {
    const view = computeNatStunView(nat());
    expect(view.probeEnabled).toBe(true);
    expect(view.liveServers).toBe(1);
    expect(view.configuredServers).toBe(2);
  });

  it("is undefined for a family with no reflection result yet", () => {
    expect(computeNatStunView(nat()).v4Addr).toBeUndefined();
  });

  it("reads reflection addresses when present", () => {
    const view = computeNatStunView(
      nat({ reflection: { v4: { addr: "1.2.3.4", age_secs: 5 }, v6: { addr: "::1", age_secs: 5 } } }),
    );
    expect(view.v4Addr).toBe("1.2.3.4");
    expect(view.v6Addr).toBe("::1");
  });

  it("treats a null configured list as zero configured servers (nil Go slice on the wire)", () => {
    const view = computeNatStunView(nat({ servers: { configured: null, live: [], live_total: 0 } }));
    expect(view.configuredServers).toBe(0);
  });
});
