import { localeOf, type Dict } from "../i18n";

// formatLogClock renders a LogLine's `ts` as a tabular HH:MM:SS clock —
// live log lines are almost always "just now", so the date is noise; the
// caller applies the `tabular-nums` utility class (design system rule: all
// numbers) rather than this function padding digits itself.
//
// hour12 is pinned off in both languages: an operator scanning a log feed
// reads elapsed time off it, and 12-hour clocks (English's Intl default)
// make two lines an hour apart look identical.
export function formatLogClock(ts: string, s: Dict): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString(localeOf(s), { hour12: false });
}

// formatAuditTimestamp renders an AuditEntry's `ts` as date + clock — audit
// entries (Task 7 deliverable D) can span days, unlike the live log feed,
// so the date matters here. The day/month ORDER follows the locale (ru:
// 26.08, en: 08/26), which is exactly why this goes through Intl rather
// than a hand-built template.
export function formatAuditTimestamp(ts: string, s: Dict): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(localeOf(s), {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatAuditClock(ts: string, s: Dict): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString(localeOf(s), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatAuditDay(ts: string, s: Dict, now = new Date()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const difference = Math.round((today - day) / 86_400_000);
  if (difference === 0) return s.journal.actions.today;
  if (difference === 1) return s.journal.actions.yesterday;
  return d.toLocaleDateString(localeOf(s), { day: "2-digit", month: "2-digit" });
}
