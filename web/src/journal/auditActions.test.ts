import { describe, expect, it } from "vitest";
import { isKnownAuditAction, renderAuditAction } from "./auditActions";
import type { AuditEntry } from "../lib/api/generated/types.gen";

// KNOWN_BACKEND_ACTIONS mirrors every literal string passed as the first
// argument to `s.appendAudit(...)` across internal/httpapi/*.go (excluding
// _test.go files) as of the branch this test was written against. Refresh
// by re-running:
//   grep -rhn 'appendAudit(' internal/httpapi/*.go | grep -v _test.go
// from the repo's `src/` worktree root and updating this list to match
// every first-argument string literal found. api/openapi.yaml's
// AuditEntry.action is documented as free text, not a schema enum (unlike
// Error.code), so there's no machine-checkable source of truth to parse
// the way ru.test.ts walks openapi.yaml for error codes — this hardcoded,
// commented list is the deliberately simpler alternative (Task 7 brief D).
const KNOWN_BACKEND_ACTIONS = [
  "login",
  "login.failed",
  "logout",
  "user.create",
  "user.patch",
  "user.delete",
  "quota.reset",
  "secret.rotate",
  "user.enabled",
  "sublink.rotate",
  "config.patch",
  "telemt.reload",
  "telemt.restart",
  "update.apply",
  "update.auto_change",
];

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return { ts: "2026-08-25T12:00:00Z", action: "login", ...overrides };
}

describe("audit action dictionary completeness", () => {
  it("has a label for every action the backend actually emits", () => {
    for (const action of KNOWN_BACKEND_ACTIONS) {
      expect(isKnownAuditAction(action), `missing label for action "${action}"`).toBe(true);
    }
  });
});

describe("renderAuditAction", () => {
  it("renders label + subject for a plain action", () => {
    expect(renderAuditAction(entry({ action: "user.create", subject: "alice" }))).toBe(
      "Создан пользователь — alice",
    );
  });

  it("omits the subject segment when there is none", () => {
    expect(renderAuditAction(entry({ action: "telemt.restart" }))).toBe("Перезапущен Telemt");
  });

  it("renders the enabled/disabled branch for user.enabled from its detail string", () => {
    expect(
      renderAuditAction(entry({ action: "user.enabled", subject: "bob", detail: "enabled=true" })),
    ).toBe("Изменён статус пользователя — bob — включён");
    expect(
      renderAuditAction(entry({ action: "user.enabled", subject: "bob", detail: "enabled=false" })),
    ).toBe("Изменён статус пользователя — bob — отключён");
  });

  it("falls back to a labeled raw action string for an unrecognized action", () => {
    expect(renderAuditAction(entry({ action: "future.action", subject: "x" }))).toBe(
      "Неизвестное действие: future.action — x",
    );
  });

  it("every known action renders a non-empty string without throwing", () => {
    for (const action of KNOWN_BACKEND_ACTIONS) {
      const rendered = renderAuditAction(entry({ action, subject: "s", detail: "enabled=true" }));
      expect(rendered.length).toBeGreaterThan(0);
    }
  });
});
