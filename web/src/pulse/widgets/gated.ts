import type { Gated } from "../../realtime/topics";

export type GatedResult<T> = { status: "gated"; reason?: string } | { status: "ok"; data: T };

// resolveGated is the shared "is this Gated[T] payload actually usable"
// check for every runtime/security widget built on Telemt's Gated[T]
// wrapper (me_pool_state, me_quality, nat_stun, me_selftest, recent_events,
// tls_fingerprints). `gated` being null/undefined covers two wire cases the
// caller does not need to tell apart here: the sub-call failed this poll
// (hub.go leaves the field an explicit JSON null) or the field was omitted
// entirely because the runtime_edge capability is off — both render the
// same "gated" fallback; only the reason text differs (present vs the
// caller's own hint). Call only after confirming the parent topic itself
// has loaded (topic.data !== null) — this function has no way to tell
// "topic not loaded yet" from "this one field is off".
export function resolveGated<T>(gated: Gated<T> | null | undefined): GatedResult<T> {
  if (!gated || !gated.enabled || !gated.data) return { status: "gated", reason: gated?.reason };
  return { status: "ok", data: gated.data };
}
