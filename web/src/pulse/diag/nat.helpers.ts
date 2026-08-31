import type { RuntimeNatStun } from "../../realtime/topics";
import { reflectionAgeSecs, STUN_REFLECTION_TTL_SECONDS } from "../details-builder/definitions/nat";

export type NatMechanismState = "fresh" | "delayed" | "stale" | "pending" | "missing" | "disabled";

export function natMechanismState(nat: RuntimeNatStun): NatMechanismState {
  const enabled = nat.flags.nat_probe_enabled && !nat.flags.nat_probe_disabled_runtime;
  if (!enabled) return "disabled";
  const age = reflectionAgeSecs(nat);
  const failed =
    (nat.flags.nat_probe_attempts ?? 0) > 0 || (nat.stun_backoff_remaining_ms ?? 0) > 0;
  if (age === null) return failed ? "missing" : "pending";
  if (age < STUN_REFLECTION_TTL_SECONDS) return "fresh";
  return failed ? "delayed" : "stale";
}
