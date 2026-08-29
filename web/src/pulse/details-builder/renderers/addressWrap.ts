// An address carries no whitespace, so the narrow §15.2 value column breaks
// it wherever the line happens to end — `stun1.example.n` over `et:3478`,
// ten rows in a row on the NAT page at 360 px. It does have boundaries a
// reader recognizes, though: the dots between DNS labels and the colon in
// front of the port. addressSegments cuts the text at exactly those, and
// the renderer puts a `<wbr>` between the pieces.
//
// `<wbr>` is a break OPPORTUNITY, not a break: the browser takes the last
// one that fits and falls back to `overflow-wrap: anywhere` only for a
// single label wider than the column, so the value is never pushed past the
// edge. It contributes nothing to a selection or a copy, which is what
// keeps the value verbatim (§13.2).
//
// The dot stays with the label before it and the colon goes with the port
// after it, so each line ends and begins on something whole:
//
//   stun1.example.          198.51.100.1
//   net:3478                :443
//
/** Cuts an address after every dot and before every colon. */
export function addressSegments(text: string): string[] {
  // Anything with whitespace already has ordinary break opportunities, and
  // anything without a dot or a colon has no boundary worth offering.
  if (/\s/.test(text) || !/[.:]/.test(text)) return [text];
  const segments: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch === ":") {
      if (current !== "") segments.push(current);
      current = ":";
      continue;
    }
    current += ch;
    if (ch === ".") {
      segments.push(current);
      current = "";
    }
  }
  if (current !== "") segments.push(current);
  return segments;
}
