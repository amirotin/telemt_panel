// findUnsafeIntegerLiterals scans raw JSON *text* (not the parsed value —
// by the time JSON.parse has run, an out-of-range integer literal has
// already been silently rounded to the nearest representable double, so
// there is nothing left in the parsed result to detect it from) for bare
// integer literals outside Number.isSafeInteger's range. The raw editor
// (RawConfigEditor.tsx) calls this on every doc change and blocks submit
// when it finds one — a config value like a huge upstream_id or a
// timestamp typed by hand must not silently drift by editing it here.
//
// Strings are masked out first (their digits are never JSON number
// tokens) via a small hand-rolled scanner rather than a single regex —
// JSON string escaping (\", \\) makes a purely regex-based "skip strings"
// pass unreliable, and this project has no JSON-tokenizer dependency to
// reach for instead.
function maskStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    // Inside a string. An escaped character (following a backslash that
    // wasn't itself escaped) is masked regardless of what it is — this is
    // what keeps an escaped quote (\") from being misread as the string's
    // closing quote.
    if (escaped) {
      escaped = false;
      out += "x";
    } else if (ch === "\\") {
      escaped = true;
      out += "x";
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else {
      out += "x";
    }
  }
  return out;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
// Bare integer tokens only — a literal with a fractional part or an
// exponent isn't meant to be read as an exact integer in the first place,
// so it's out of scope for this check.
const INTEGER_TOKEN = /-?\d+/g;

export function findUnsafeIntegerLiterals(jsonText: string): string[] {
  const masked = maskStrings(jsonText);
  const found = new Set<string>();
  for (const match of masked.matchAll(INTEGER_TOKEN)) {
    const token = match[0];
    // A bare integer immediately followed by '.' or 'e'/'E' is actually
    // part of a float/exponent literal (e.g. the "123" in "123.45" or
    // "123e10") — BigInt(token) alone would misjudge it as a huge exact
    // integer. Skip those; the float/exponent form isn't this check's
    // concern.
    const after = masked[match.index + token.length];
    if (after === "." || after === "e" || after === "E") continue;
    const value = BigInt(token);
    if (value > MAX_SAFE || value < MIN_SAFE) found.add(token);
  }
  return [...found];
}
