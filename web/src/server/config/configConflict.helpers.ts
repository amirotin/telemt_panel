import { isPlainObject, valuesEqual } from "./configObjectDiff";

// diffChangedSectionKeys computes the flat "section.key" paths that differ
// between two GET /api/telemt/config `sections` snapshots — the panel's
// stale baseline (fetched when the admin started editing) versus a fresh
// re-fetch taken right after a 409 revision_conflict. 06-ui.md's revision-
// conflict banner shows *what* changed on the server, not just that a
// conflict happened, so the admin can tell whether it's safe to reload and
// redo their edit or whether someone else touched the exact field they
// were changing.
export function diffChangedSectionKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const sections = new Set([...Object.keys(before), ...Object.keys(after)]);
  const paths: string[] = [];
  for (const section of sections) {
    collectDiffPaths(before[section], after[section], section, paths);
  }
  return paths.sort();
}

function collectDiffPaths(a: unknown, b: unknown, prefix: string, out: string[]): void {
  // Recurse as soon as either side is a plain object (a brand-new or
  // fully-removed section still walks down to per-leaf paths, treating the
  // missing side as `{}` — same convention buildConfigPatch's diffObject
  // uses for a section absent from `original`), not only when both sides
  // already agree on being objects.
  if (isPlainObject(a) || isPlainObject(b)) {
    const ao = isPlainObject(a) ? a : {};
    const bo = isPlainObject(b) ? b : {};
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) collectDiffPaths(ao[k], bo[k], `${prefix}.${k}`, out);
    return;
  }
  if (!valuesEqual(a, b)) out.push(prefix);
}
