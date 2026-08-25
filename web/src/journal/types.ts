// LogicalService mirrors openapi's `service` enum for /api/events/logs,
// /api/logs/tail and /api/host's manual_commands — telemt (the proxy) or
// panel (this app itself), matching internal/httpapi's resolveLogicalService.
export type LogicalService = "telemt" | "panel";
