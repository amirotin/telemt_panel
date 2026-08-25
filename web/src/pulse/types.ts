// Shared identifier types for the Пульс dashboard (widgets/registry.ts,
// layout.ts, WidgetFrame.tsx, the Диагностика routes) — pulled out of
// registry.ts so WidgetFrame can reference DiagDomain without importing the
// registry itself (which imports every widget component, including ones
// that render WidgetFrame — a type-only import would be erased at compile
// time either way, but keeping the value-importing edges one-directional
// avoids the question entirely).

// DiagDomain enumerates the seven Диагностика drill-down pages
// (06-ui.md §Пульс: "Соединения · DC · Upstreams · ME · NAT/STUN · Security
// · Счётчики") — a widget's optional diagDomain links to one of these.
export type DiagDomain = "connections" | "dc" | "upstreams" | "me" | "nat" | "security" | "counters";

// WidgetId enumerates the dashboard's widget catalog (06-ui.md's widget
// list) — the layout store persists an ordered array of these.
export type WidgetId =
  | "health_hero"
  | "stat_row"
  | "problems"
  | "active_sessions"
  | "dc"
  | "upstreams"
  | "me_pool"
  | "nat_stun"
  | "selftest"
  | "recent_events"
  | "security_posture"
  | "tls_fingerprints";
