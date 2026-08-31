// Shared identifier types for overview widgets and diagnostics routes.

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
