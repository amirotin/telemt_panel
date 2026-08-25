// formatLogClock renders a LogLine's `ts` as a tabular HH:MM:SS clock —
// live log lines are almost always "just now", so the date is noise; the
// caller applies the `tabular-nums` utility class (design system rule: all
// numbers) rather than this function padding digits itself.
export function formatLogClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString("ru-RU", { hour12: false });
}

// formatAuditTimestamp renders an AuditEntry's `ts` as date + clock — audit
// entries (Task 7 deliverable D) can span days, unlike the live log feed,
// so the date matters here.
export function formatAuditTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
