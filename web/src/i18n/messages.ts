import type { Dict } from "./dict";
import { ru } from "./ru";

// The two dynamic-key tables live inside the dictionaries (ru.errors /
// ru.auditActions) so en.ts must translate every entry or fail to compile.
// Their keys arrive off the wire as plain strings, though, so the lookup
// itself has to widen the exact-key object type once, here, instead of
// casting at every call site.
function table(entries: Dict["errors"] | Dict["auditActions"]): Record<string, string> {
  return entries as unknown as Record<string, string>;
}

// errorMessage looks up a human message for an envelope {code}, falling
// back to errors.default for anything this build doesn't recognize (a
// future backend code, or a partially rolled-out deployment).
export function errorMessage(s: Dict, code: string): string {
  return table(s.errors)[code] ?? s.errors.default;
}

// auditActionLabel returns the label for an audit action, or undefined for
// an action string this build doesn't know yet.
export function auditActionLabel(s: Dict, action: string): string | undefined {
  return table(s.auditActions)[action];
}

// isKnownAuditAction reads the Russian table deliberately: the KEY set is
// the contract with the backend and is locale-independent, and ru.ts is the
// dictionary that defines the shape both languages share.
export function isKnownAuditAction(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(ru.auditActions, action);
}
