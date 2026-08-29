// A Telemt field name carries no whitespace, so the left column of a
// DescribedRow breaks it wherever the line happens to end:
// `stun_backoff_remainin` over `g_ms` on NAT, `generated_at_epoch_se` over
// `cs` on Upstreams, `handshake_failures_by_cla` over `ss[]` on Connections
// — all at 360 px, all reading as a typo rather than as a wrap.
//
// snake_case has boundaries a reader already recognizes: the underscores,
// the dots of a nested path, and the bracket of an index. fieldNameSegments
// cuts at exactly those and the row puts a `<wbr>` between the pieces.
//
// Same reasoning and same mechanics as addressSegments in the Details
// renderers — a break OPPORTUNITY, not a break: the browser takes the last
// one that fits and falls back to breaking mid-token only for a single
// segment wider than the column, so a name is never pushed past the edge
// and never silently truncated. `<wbr>` contributes nothing to a selection
// or a copy, so the name stays verbatim and searchable.
//
// The separator stays with the segment BEFORE it, so a line ends on
// something whole:
//
//   stun_backoff_        handshake_failures_
//   remaining_ms         by_class[]

/** Cuts a field name after every `_` and `.`, and before every `[`. */
export function fieldNameSegments(text: string): string[] {
  // Anything with whitespace already has ordinary break opportunities; a
  // name with no separator has no boundary worth offering.
  if (/\s/.test(text) || !/[_.[]/.test(text)) return [text];
  const segments: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch === "[") {
      if (current !== "") segments.push(current);
      current = "[";
      continue;
    }
    current += ch;
    if (ch === "_" || ch === ".") {
      segments.push(current);
      current = "";
    }
  }
  if (current !== "") segments.push(current);
  return segments;
}
