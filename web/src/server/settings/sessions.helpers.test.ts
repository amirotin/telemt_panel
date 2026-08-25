import { describe, expect, it } from "vitest";
import { sessionDeviceLabel, sortSessions } from "./sessions.helpers";
import type { SessionInfo } from "../../lib/api/generated/types.gen";

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: "s1",
    created: "2026-08-01T00:00:00Z",
    last_seen: "2026-08-01T00:00:00Z",
    current: false,
    ...overrides,
  };
}

describe("sortSessions", () => {
  it("puts the current session first regardless of last_seen", () => {
    const sessions = [
      session({ id: "old-but-current", current: true, last_seen: "2026-08-01T00:00:00Z" }),
      session({ id: "newer-other", current: false, last_seen: "2026-08-20T00:00:00Z" }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(["old-but-current", "newer-other"]);
  });

  it("orders the rest by most-recent last_seen first", () => {
    const sessions = [
      session({ id: "a", last_seen: "2026-08-10T00:00:00Z" }),
      session({ id: "b", last_seen: "2026-08-20T00:00:00Z" }),
      session({ id: "c", last_seen: "2026-08-15T00:00:00Z" }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const sessions = [session({ id: "a" }), session({ id: "b", current: true })];
    const original = [...sessions];
    sortSessions(sessions);
    expect(sessions).toEqual(original);
  });
});

describe("sessionDeviceLabel", () => {
  it("returns the parsed label when present", () => {
    expect(sessionDeviceLabel(session({ user_agent_label: "iPhone · Safari" }))).toBe("iPhone · Safari");
  });

  it("falls back for an absent label", () => {
    expect(sessionDeviceLabel(session({}))).not.toBe("");
  });

  it("falls back for a blank/whitespace-only label", () => {
    expect(sessionDeviceLabel(session({ user_agent_label: "   " }))).not.toBe("   ");
  });
});
