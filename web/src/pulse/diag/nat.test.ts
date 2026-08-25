import { describe, expect, it } from "vitest";
import { natGroups } from "./nat.helpers";
import type { RuntimeNatStun } from "../../realtime/topics";

const nat: RuntimeNatStun = {
  flags: { nat_probe_enabled: true, nat_probe_disabled_runtime: false, nat_probe_attempts: 3 },
  servers: { configured: ["stun1"], live: ["stun1"], live_total: 1 },
  reflection: { v4: { addr: "1.2.3.4", age_secs: 10 } },
};

describe("natGroups", () => {
  it("emits flags, servers, reflection in order", () => {
    expect(natGroups(nat).map((g) => g.title)).toEqual(["Флаги", "STUN-серверы", "Отражение (reflection)"]);
  });

  it("flattens the reflection sub-object, including the missing v6 branch", () => {
    const groups = natGroups(nat);
    const reflection = groups[2];
    expect(reflection.rows.map((r) => r.key)).toEqual(["v4.addr", "v4.age_secs"]);
  });
});
