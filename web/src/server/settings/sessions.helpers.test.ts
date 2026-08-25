import { describe, expect, it } from "vitest";
import {
  parseUserAgent,
  sessionDeviceLabel,
  sessionUserAgentRaw,
  sortSessions,
} from "./sessions.helpers";
import { ru } from "../../i18n/ru";
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

describe("parseUserAgent", () => {
  it("names Chrome on Linux", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome", platform: "Linux", label: "Chrome · Linux" });
  });

  it("names Safari on iPhone rather than Chrome/Linux lookalikes", () => {
    // An iPhone Safari UA contains "like Mac OS X" — the iPhone probe has
    // to win, and "Safari/" must not be shadowed by a missing "Chrome/".
    expect(
      parseUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ).label,
    ).toBe("Safari · iPhone");
  });

  it("prefers Edge over the Chrome and Safari tokens its UA also carries", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      ).label,
    ).toBe("Edge · Windows");
  });

  it("prefers Android over the Linux token its UA also carries", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      ).label,
    ).toBe("Chrome · Android");
  });

  it("names Chromium-family agents Chrome, not Safari", () => {
    // "HeadlessChrome/" has no word boundary before "Chrome", so the plain
    // probe misses it and the Safari token every Chromium UA carries wins.
    expect(
      parseUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36",
      ).label,
    ).toBe("Chrome · Linux");
    expect(
      parseUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/131.0.0.0 Safari/537.36",
      ).label,
    ).toBe("Chromium · Linux");
  });

  it("names Firefox on macOS", () => {
    expect(
      parseUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0")
        .label,
    ).toBe("Firefox · macOS");
  });

  it("handles a non-browser client", () => {
    expect(parseUserAgent("curl/8.5.0")).toEqual({
      browser: "curl",
      platform: null,
      label: "curl",
    });
  });

  it("returns nulls for an empty or unrecognised agent", () => {
    expect(parseUserAgent(undefined).label).toBeNull();
    expect(parseUserAgent("   ").label).toBeNull();
    expect(parseUserAgent("SomeInternalProbe/1.0").label).toBeNull();
  });

  it("passes a string that is not a User-Agent through untouched", () => {
    // No product/version token — an already-friendly label, not a UA.
    expect(parseUserAgent("iPhone · Safari").label).toBeNull();
  });
});

describe("sessionDeviceLabel / sessionUserAgentRaw", () => {
  const base = { id: "s1", created: "2026-01-01T00:00:00Z", last_seen: "2026-01-01T00:00:00Z", current: false };
  const chromeUA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  it("shows the parsed label and keeps the raw string for the tooltip", () => {
    const s = { ...base, user_agent_label: chromeUA };
    expect(sessionDeviceLabel(s)).toBe("Chrome · Linux");
    expect(sessionUserAgentRaw(s)).toBe(chromeUA);
  });

  it("falls back to the raw agent when nothing matched, without repeating it", () => {
    const s = { ...base, user_agent_label: "SomeInternalProbe/1.0" };
    expect(sessionDeviceLabel(s)).toBe("SomeInternalProbe/1.0");
    expect(sessionUserAgentRaw(s)).toBeNull();
  });

  it("falls back to the generic label when there is no agent at all", () => {
    expect(sessionDeviceLabel({ ...base })).toBe(ru.server.settings.unknownDevice);
    expect(sessionUserAgentRaw({ ...base })).toBeNull();
  });
});
