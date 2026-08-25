// safeRedirectTarget validates a redirect destination that came off the
// wire (the `redirect` search param on /login, round-tripped through
// requireAuth) before it's ever handed to router.navigate()/redirect() as
// `href`. Those accept ANY URL-parseable string and, for one starting with
// a scheme or "//", do a real `window.location.href = ...` navigation —
// so an unvalidated `redirect` param is a textbook open redirect
// (`/login?redirect=https://evil.example` sends the admin off-site right
// after they authenticate). Only a same-app, single-leading-slash path is
// ever accepted; anything else — including a bare "//host" (protocol-
// relative), a backslash anywhere (some URL parsers normalize backslash to
// forward slash for special schemes, turning "/\evil" into "//evil"), a
// control character, or a string `new URL()` would resolve to a different
// origin — falls back to the landing section.
const FALLBACK = "/people";

// eslint-disable-next-line no-control-regex -- deliberately matching control chars to reject them
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function safeRedirectTarget(raw: string | undefined): string {
  if (!raw) return FALLBACK;
  if (CONTROL_CHARS.test(raw)) return FALLBACK;
  // Backslash anywhere is rejected outright — no legitimate in-app route
  // needs one, and it's the classic bypass some URL parsers fall for.
  if (raw.includes("\\")) return FALLBACK;
  // Exactly one leading "/" — rules out "//evil.example" (protocol-relative)
  // and anything with a scheme ("https:...", "javascript:...", which don't
  // start with "/" at all).
  if (!raw.startsWith("/") || raw.startsWith("//")) return FALLBACK;
  // No dot-dot segments and no percent-encoded slashes/backslashes: both
  // resolve same-origin (so the URL check below accepts them) but are
  // exactly the shapes bypass attempts take — reject them outright.
  if (/(^|\/)\.\.(\/|$)/.test(raw) || /%(2f|5c)/i.test(raw)) return FALLBACK;

  // Defense in depth: confirm a real URL parser resolves `raw` against an
  // arbitrary base to something still on that base's origin — catches any
  // bypass not already ruled out above.
  const base = "http://redirect-base.invalid";
  try {
    if (new URL(raw, base).origin !== base) return FALLBACK;
  } catch {
    return FALLBACK;
  }

  return raw;
}
