import type { Dict } from "../i18n";

// GateHintKey enumerates the panel's static "как включить" hints for a
// disabled capability/gate — Telemt's own Gated[T] wrapper (07-telemt-sdk.md)
// already carries a dynamic `reason` string for its own sub-gates (e.g.
// "minimal runtime gate disabled"), shown as-is by <Gated>; the entries here
// are the panel-authored follow-up text for the capability flags exposed by
// GET /api/telemt/info (07-telemt-sdk.md §SDK-3) and the runtime_edge gate
// that unlocks several of the payloads underneath it. The text itself lives
// in the dictionaries (gated.hints) — this module only owns the key
// enumeration and the typed lookup.
export type GateHintKey =
  | "runtime_edge"
  // telemt_outdated is the one key that is not a capability name: it is the
  // follow-up for `unsupported` (the route is absent from this build, 501
  // capability_absent) as opposed to `disabled` (the feature exists and is
  // switched off) — ruling R5.
  | "telemt_outdated"
  | "quota"
  | "config_api"
  | "reload_api"
  | "user_enable_disable"
  | "rotate_secret"
  | "log_stream"
  | "minimal_runtime_enabled";

export function gateHint(s: Dict, key: GateHintKey): string {
  return s.gated.hints[key];
}
