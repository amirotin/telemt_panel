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
