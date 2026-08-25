import { ru } from "../i18n/ru";

// GateHintKey enumerates the panel's static "как включить" hints for a
// disabled capability/gate — Telemt's own Gated[T] wrapper (07-telemt-sdk.md)
// already carries a dynamic `reason` string for its own sub-gates (e.g.
// "minimal runtime gate disabled"), shown as-is by <Gated>; the entries here
// are the panel-authored follow-up text for the capability flags exposed by
// GET /api/telemt/info (07-telemt-sdk.md §SDK-3) and the runtime_edge gate
// that unlocks several of the payloads underneath it. The Russian text
// itself lives in ru.ts (ru.gated.hints) — this module only owns the key
// enumeration and the typed lookup, per the single-strings-module rule.
export type GateHintKey =
  | "runtime_edge"
  | "quota"
  | "config_api"
  | "reload_api"
  | "user_enable_disable"
  | "rotate_secret"
  | "log_stream"
  | "minimal_runtime_enabled";

export const gateHints: Record<GateHintKey, string> = { ...ru.gated.hints };
