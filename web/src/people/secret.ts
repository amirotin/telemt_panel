// generateSecret produces a fresh 32-hex-character Telemt user secret
// client-side (07-telemt-sdk.md: "secret 32hex (генерится, если нет)") —
// the create form always generates one up front so what's shown/copyable
// before submit is exactly what gets sent, rather than round-tripping
// through the server first. Uses the Web Crypto API (available in every
// supported browser and in Node 22), never Math.random.
export function generateSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
