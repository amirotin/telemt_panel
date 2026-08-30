// Shared identifier types for the Пульс dashboard (widgets/registry.ts,
// layout.ts, WidgetFrame.tsx, the Диагностика routes) — pulled out of
// registry.ts so WidgetFrame can reference DiagDomain without importing the
// registry itself (which imports every widget component, including ones
// that render WidgetFrame — a type-only import would be erased at compile
// time either way, but keeping the value-importing edges one-directional
// avoids the question entirely).

// DiagDomain enumerates the nine Диагностика drill-down pages
// (06-ui.md §Пульс: "Соединения · DC · Upstreams · ME · NAT/STUN · Security
// · Счётчики", plus События — M4 task 8's own page, which the plan's Пульс
// hub lists alongside the other seven) — a widget's optional diagDomain
// links to one of these.
export type DiagDomain =
  | "connections"
  | "dc"
  | "upstreams"
  | "me"
  | "nat"
  | "security"
  | "counters"
  | "events"
  // web — Telemt >= 3.5.3's WEB proxy mode (M4 task 8b). The ninth card on
  // the hub; on an older build it reads as `unsupported`, not as a gate the
  // operator can flip.
  | "web";

// WidgetId enumerates the dashboard's widget catalog (06-ui.md's widget
// list) — the layout store persists an ordered array of these.
export type WidgetId =
  | "health_hero"
  | "stat_row"
  | "problems"
  | "online_now"
  | "dc"
  | "upstreams"
  | "me_pool"
  | "web"
  | "selftest"
  | "recent_events"
  | "tls_fingerprints";
