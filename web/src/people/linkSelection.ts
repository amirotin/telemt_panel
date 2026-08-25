import type { UserLinksWire } from "../realtime/topics";

// pickTelegramLink chooses which of a user's ready-made links "Открыть в
// Telegram" opens: fake-TLS first (hardest to detect/block), then secure,
// then classic — the action-sheet brief's own order ("first tls link if
// present else secure/classic"). Links come ready-made from Telemt
// (07-telemt-sdk.md SDK rule 6); this only selects among them, never builds
// one.
export function pickTelegramLink(links: UserLinksWire): string | null {
  if (links.tls.length > 0) return links.tls[0];
  if (links.secure.length > 0) return links.secure[0];
  if (links.classic.length > 0) return links.classic[0];
  return null;
}

// isSafeTelegramLink gates "Открыть в Telegram" (window.location.href = link)
// against a Telemt-supplied link that isn't actually one of the two shapes
// Telemt's own link builder ever produces: a tg: URI, or an https://t.me/
// share link. Telemt's link content is treated as untrusted for navigation
// purposes even though the panel never constructs these links itself
// (parseLink.ts's own rule) — a compromised/misbehaving upstream shouldn't
// be able to steer the admin's browser to an arbitrary or javascript: URL.
export function isSafeTelegramLink(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === "tg:") return true;
  return scheme === "https:" && url.hostname.toLowerCase() === "t.me";
}
