import type {
  MeWritersData,
  RuntimeGates,
  RuntimeInitialization,
  RuntimeMePoolState,
  RuntimeMeQuality,
  RuntimeMeSelftest,
  RuntimeMinimalMeRuntime,
} from "../../realtime/topics";
import type { MePagePayload } from "../details-builder/definitions/me";

export type MeRouteMode = "middle" | "fallback" | "direct";

// Direct-only is a valid configuration, while fallback is a separate runtime
// decision. Keeping the three modes explicit prevents a disabled ME pool from
// being reported as an outage.
export function meRouteMode(
  gates: RuntimeGates | null,
  writers: MeWritersData | null,
): MeRouteMode {
  if (
    gates?.reroute_active ||
    (gates?.use_middle_proxy === true && gates.route_mode.toLowerCase() === "direct")
  ) {
    return "fallback";
  }
  if (gates?.use_middle_proxy === true || writers?.middle_proxy_enabled === true) return "middle";
  return "direct";
}

export interface MeSourcesInput {
  /** `upstreams` topic — me-writers, the only always-on half of the page. */
  meWriters?: MeWritersData | null;
  /** `runtime` topic — never gated. */
  gates?: RuntimeGates | null;
  initialization?: RuntimeInitialization | null;
  /** `runtime` topic behind the runtime_edge gate; absent when it is off. */
  pool?: RuntimeMePoolState | undefined;
  quality?: RuntimeMeQuality | undefined;
  selftest?: RuntimeMeSelftest | undefined;
  /** minimal.data.me_runtime, behind the separate minimal_runtime_enabled gate. */
  meRuntime?: RuntimeMinimalMeRuntime | undefined;
}

// mePagePayload joins the five independently gated sub-payloads the ME
// domain is spread across into the ONE payload its definition reads
// (details-builder/definitions/me.ts).
//
// This is all that is left of the old `meGroups`, which flattened the same
// inputs into thirteen KV groups and ~1 091 rows: composition of the page is
// now the definition's job, and this module only says WHERE the data comes
// from. Every half is optional on its own — a gated-off sub-payload simply
// contributes no fields, and the page reports it as a degraded source while
// every other section keeps working (spec §14).
//
// The me-writers half is spread FLAT (`summary`, `writers`,
// `middle_proxy_enabled`, …) because the field catalog keys those paths
// exactly as the wire spells them; the runtime halves keep their own
// prefixes, which is what stops `pool.writers` and `writers` from being the
// same path.
export function mePagePayload(input: MeSourcesInput): MePagePayload | null {
  const writers = input.meWriters ?? null;
  const payload: MePagePayload = {
    ...(writers
      ? {
          middle_proxy_enabled: writers.middle_proxy_enabled,
          ...(writers.reason !== undefined ? { reason: writers.reason } : {}),
          generated_at_epoch_secs: writers.generated_at_epoch_secs,
          summary: writers.summary,
          writers: writers.writers,
        }
      : {}),
    ...(input.gates ? { gates: input.gates } : {}),
    ...(input.initialization ? { initialization: input.initialization } : {}),
    ...(input.pool ? { pool: input.pool } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.selftest ? { selftest: input.selftest } : {}),
    ...(input.meRuntime ? { me_runtime: input.meRuntime } : {}),
  };
  return Object.keys(payload).length === 0 ? null : payload;
}
