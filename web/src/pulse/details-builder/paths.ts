// Normalized paths — the addressing scheme the whole builder shares.
//
// Spec §8.3: the field catalog is keyed by the panel's normalized model
// path, not by a raw Telemt JSON pointer, so a rename between Telemt, the
// Go SDK and the frontend model cannot silently orphan every description.
// In practice the two coincide today; keeping the normalization in ONE
// place is what makes a future divergence a one-file change.
//
// Shape: object keys are joined with ".", array elements are addressed as
// "[i]" — `dcs[0].endpoint_writers[2].endpoint`. This is deliberately the
// same spelling `pulse/diag/rows.ts`'s flattenToRows already produces, so
// a path that appears in the raw fallback and a path in the catalog are
// literally the same string.
//
// Wildcards use "*" for one whole segment: `dcs.*.rtt_ms` matches
// `dcs[0].rtt_ms` and `dcs[11].rtt_ms`. A wildcard never spans segments —
// there is no "**" — because a catalog entry that matched at any depth
// would start describing fields it has never seen (spec §8.2: the builder
// MUST NOT invent business meaning for an unknown field).

/** One step of a normalized path: an object key or an array index. */
export type PathSegment = string;

// splitPath tokenizes a normalized path into its segments. Array indices
// lose their brackets: "dcs[0].rtt_ms" -> ["dcs", "0", "rtt_ms"], which is
// what makes "*" able to match an index and a key alike.
export function splitPath(path: string): PathSegment[] {
  if (path === "") return [];
  const out: PathSegment[] = [];
  let current = "";
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === ".") {
      if (current !== "") out.push(current);
      current = "";
      continue;
    }
    if (ch === "[") {
      if (current !== "") out.push(current);
      current = "";
      const end = path.indexOf("]", i);
      if (end === -1) {
        // Malformed input — treat the rest as one literal segment rather
        // than throwing: a path only ever comes from our own walkers, and
        // a crash in a formatter is worse than a wrong-looking label.
        current = path.slice(i + 1);
        break;
      }
      out.push(path.slice(i + 1, end));
      i = end;
      continue;
    }
    current += ch;
  }
  if (current !== "") out.push(current);
  return out;
}

/** joinPath is splitPath's inverse: numeric segments become "[i]". */
export function joinPath(segments: readonly PathSegment[]): string {
  let out = "";
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      out += `[${seg}]`;
      continue;
    }
    out += out === "" ? seg : `.${seg}`;
  }
  return out;
}

/** childPath appends one object key to a parent path. */
export function childPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

/** indexPath appends one array index to a parent path. */
export function indexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

// matchesPattern tests a concrete normalized path against a (possibly
// wildcarded) catalog pattern. Segment counts must be equal — see the
// module comment on why there is no "**".
export function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes("*")) return path === pattern;
  const p = splitPath(path);
  const q = splitPath(pattern);
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (q[i] !== "*" && q[i] !== p[i]) return false;
  }
  return true;
}

// patternSpecificity ranks two matching wildcard patterns so the more
// concrete one wins: more literal (non-"*") segments first, then the
// longer pattern. Without an explicit order, catalog lookup would depend on
// insertion order, which makes "why does this field show the generic
// description" impossible to reason about.
export function patternSpecificity(pattern: string): number {
  const segs = splitPath(pattern);
  let literals = 0;
  for (const s of segs) if (s !== "*") literals++;
  return literals * 1000 + segs.length;
}

// isUnderPath answers "does `path` live inside the subtree rooted at
// `prefix`" — the primitive behind consumed-path tracking: a section that
// declares it renders `endpoint_writers` consumes every leaf beneath it.
// Prefix "" is the whole payload. Segment-aware on purpose: a plain
// startsWith would make "load" swallow "load_average".
export function isUnderPath(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  if (path === prefix) return true;
  const p = splitPath(path);
  const q = splitPath(prefix);
  if (p.length < q.length) return false;
  for (let i = 0; i < q.length; i++) {
    if (p[i] !== q[i]) return false;
  }
  return true;
}

/** A leaf found by walkLeafPaths, with enough context to render or classify it. */
export interface LeafPath {
  path: string;
  value: unknown;
  /**
   * `empty-array` / `empty-object` are leaves too: a container that carries
   * no leaves of its own would otherwise vanish from the completeness
   * accounting, and spec §10.3 makes "collected but empty" a state a page
   * MUST still show.
   */
  kind: "scalar" | "null" | "empty-array" | "empty-object";
}

// walkLeafPaths enumerates every leaf a payload carries. This is the "all
// normalized paths" term of the completeness equation (spec §27.4):
//
//     all − consumed − explicitly ignored = rendered in unknown fallback
//
// Containers are NOT leaves (their children are), except when empty.
export function walkLeafPaths(value: unknown, prefix = ""): LeafPath[] {
  if (value === undefined) return [];
  if (value === null) return [{ path: prefix, value, kind: "null" }];
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path: prefix, value, kind: "empty-array" }];
    return value.flatMap((item, i) => walkLeafPaths(item, indexPath(prefix, i)));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return [{ path: prefix, value, kind: "empty-object" }];
    return entries.flatMap(([k, v]) => walkLeafPaths(v, childPath(prefix, k)));
  }
  return [{ path: prefix, value, kind: "scalar" }];
}

// readPath reads a normalized path out of a payload. Returns `undefined`
// for a missing key AND for a key whose value is undefined — the caller
// distinguishes "absent" from "present and null" by the value itself
// (§13.1: an absent optional field must differ from a collected empty one),
// which is why hasPath exists alongside this.
export function readPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const seg of splitPath(path)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

// hasPath reports whether the key exists at all, independent of its value.
// `"rtt_ms" in dc` is the only way to tell Go's omitempty ("the proxy did
// not send this") from an explicit JSON null ("measured, no sample").
export function hasPath(root: unknown, path: string): boolean {
  const segs = splitPath(path);
  let current: unknown = root;
  for (let i = 0; i < segs.length; i++) {
    if (current === null || current === undefined) return false;
    const seg = segs[i];
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return false;
      current = current[idx];
      continue;
    }
    if (typeof current !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(current, seg)) return false;
    current = (current as Record<string, unknown>)[seg];
  }
  return true;
}
