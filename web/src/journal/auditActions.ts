import { auditActionLabels, ru } from "../i18n/ru";
import type { AuditEntry } from "../lib/api/generated/types.gen";

// isKnownAuditAction — used by auditActions.test.ts's completeness check
// (every action string internal/httpapi's appendAudit call sites can emit
// must have a label) and, at runtime, to fall back cleanly for an action
// this build of the frontend doesn't know about yet (a newer backend adding
// a call site) instead of rendering a blank label.
export function isKnownAuditAction(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(auditActionLabels, action);
}

// AuditFamily groups the audit vocabulary into the handful of glyphs the
// События list draws beside each entry (the prototype puts a round icon
// tile at the head of every event row). Deliberately coarse: the icon is a
// scanning aid for "what kind of thing happened", the sentence beside it
// carries the specifics.
export type AuditFamily = "session" | "person" | "removal" | "config" | "update" | "access";

// auditActionFamily classifies an action string by its dotted prefix first
// and by the whole string second, so an action this build doesn't know yet
// (a newer backend adding "user.something") still lands in a sensible
// family instead of the generic fallback.
export function auditActionFamily(action: string): AuditFamily {
  if (action === "user.delete") return "removal";
  if (action === "login" || action === "login.failed" || action === "logout") return "session";

  const domain = action.split(".")[0];
  switch (domain) {
    case "user":
    case "quota":
      return "person";
    case "secret":
    case "sublink":
      return "access";
    case "config":
    case "telemt":
      return "config";
    case "update":
      return "update";
    default:
      return "config";
  }
}

// renderAuditAction turns one AuditEntry into a human Russian sentence for
// the Journal "События" tab (Task 7 deliverable D). Most actions are just
// "<label> — <subject>"; "user.enabled" is the one action whose meaning
// flips on its detail string (appendAudit("user.enabled", username,
// fmt.Sprintf("enabled=%t", enabled)) — internal/httpapi/users_handlers.go)
// so it gets its own branch rather than a per-action template table.
export function renderAuditAction(entry: AuditEntry): string {
  const label = auditActionLabels[entry.action] ?? `${ru.journal.events.unknownAction}: ${entry.action}`;
  const parts: string[] = [label];

  if (entry.action === "user.enabled") {
    const enabled = entry.detail?.includes("enabled=true") ?? false;
    parts.push(entry.subject ?? "", enabled ? ru.journal.events.enabledTrue : ru.journal.events.enabledFalse);
  } else if (entry.subject) {
    parts.push(entry.subject);
  }

  return parts.filter((p) => p.length > 0).join(" — ");
}
