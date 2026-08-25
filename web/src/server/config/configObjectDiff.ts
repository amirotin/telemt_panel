// Shared plain-object diff primitives for the Конфигурация page: both the
// PATCH-body builder (configPatch.helpers.ts) and the revision-conflict
// banner's "what changed on the server" list (configConflict.helpers.ts)
// need the same "walk two JSON-ish trees, find the differing leaves" logic,
// just packaged differently (a sparse merge-patch object vs a flat path
// list) — kept here once rather than duplicated.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// valuesEqual is a structural equality check for JSON-shaped values
// (objects/arrays/primitives) — used instead of a stringify-compare so
// key order never produces a false "changed" result.
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!valuesEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}
