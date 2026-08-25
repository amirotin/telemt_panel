import type { SessionInfo } from "../../lib/api/generated/types.gen";
import { ru } from "../../i18n/ru";

// sortSessions puts the current session first, then orders the rest by
// most-recently-active — the list an admin scans to find a stale/unknown
// device is far more useful with the newest activity on top and "this
// device" pinned above everything else.
export function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
  });
}

// --- User-Agent → «Chrome · Linux» ---------------------------------------
//
// `user_agent_label` is NOT a parsed label despite its name: internal/
// httpapi's userAgentLabel() just truncates the raw User-Agent header to
// 200 chars and its own comment defers the readable form to "a later
// milestone". A 120-character UA string in a 34px row is unreadable and
// unscannable, so the parsing happens here.
//
// Deliberately a short ordered table of substring probes rather than a
// UA-parsing dependency: this only has to name the handful of browsers an
// admin actually signs in from, and the ordering below is the whole trick
// (every Chromium UA also says "Safari", Edge also says "Chrome", …).
// Anything unrecognised keeps the raw string rather than guessing.

const BROWSERS: ReadonlyArray<[pattern: RegExp, name: string]> = [
  [/\bEdgA?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bYaBrowser\//, "Yandex"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  // HeadlessChrome/Chromium before the plain Chrome probe: `\bChrome\/`
  // has no word boundary inside "HeadlessChrome/", so without these a
  // Chromium-family agent falls through to the Safari token every one of
  // them also carries.
  [/HeadlessChrome\//, "Chrome"],
  [/\bChromium\//, "Chromium"],
  [/\bChrome\//, "Chrome"],
  [/\bSafari\//, "Safari"],
  [/\bcurl\//, "curl"],
];

// iOS/iPadOS first: an iPhone UA also contains "like Mac OS X", and
// Android UAs also contain "Linux".
const PLATFORMS: ReadonlyArray<[pattern: RegExp, name: string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

export interface ParsedUserAgent {
  browser: string | null;
  platform: string | null;
  /** «Chrome · Linux», «Safari · iPhone», or null when nothing matched. */
  label: string | null;
}

export function parseUserAgent(userAgent: string | undefined): ParsedUserAgent {
  const ua = userAgent?.trim() ?? "";
  // A real User-Agent always carries at least one `product/version` token.
  // Without one this isn't a UA at all — an already-friendly label from a
  // future backend, say — so pass it through untouched rather than
  // half-matching a platform word out of it.
  if (!ua || !ua.includes("/")) return { browser: null, platform: null, label: null };

  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  const platform = PLATFORMS.find(([re]) => re.test(ua))?.[1] ?? null;
  const parts = [browser, platform].filter((p): p is string => p !== null);
  return { browser, platform, label: parts.length > 0 ? parts.join(" · ") : null };
}

// sessionDeviceLabel is what the row shows: the parsed «браузер · система»
// when it could be recognised, otherwise the raw User-Agent (still more
// useful than a placeholder for spotting an unknown device), and only then
// the generic fallback — never a blank row.
export function sessionDeviceLabel(session: SessionInfo): string {
  const raw = session.user_agent_label?.trim();
  if (!raw) return ru.server.settings.unknownDevice;
  return parseUserAgent(raw).label ?? raw;
}

// sessionUserAgentRaw is the untruncated-as-received string for the row's
// tooltip and its extended-mode line — null when there is nothing to show
// or when the label already IS the raw string (no point repeating it).
export function sessionUserAgentRaw(session: SessionInfo): string | null {
  const raw = session.user_agent_label?.trim();
  if (!raw) return null;
  return parseUserAgent(raw).label === null ? null : raw;
}
