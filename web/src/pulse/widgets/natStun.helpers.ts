import type { RuntimeNatStun } from "../../realtime/topics";

export interface NatStunView {
  probeEnabled: boolean;
  liveServers: number;
  configuredServers: number;
  v4Addr?: string;
  v6Addr?: string;
}

// configured is a nil Go slice (JSON `null`, not `[]`) when no STUN servers
// are configured at all — confirmed against the live mock server.
export function computeNatStunView(nat: RuntimeNatStun): NatStunView {
  return {
    probeEnabled: nat.flags.nat_probe_enabled,
    liveServers: nat.servers.live_total,
    configuredServers: (nat.servers.configured ?? []).length,
    v4Addr: nat.reflection.v4?.addr,
    v6Addr: nat.reflection.v6?.addr,
  };
}
