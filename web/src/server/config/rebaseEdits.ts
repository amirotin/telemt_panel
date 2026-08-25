import { isPlainObject } from "./configObjectDiff";

export interface RebaseResult {
  /** freshBase with pendingPatch's leaves applied on top — always computed, regardless of overlap; the caller decides whether to use it immediately or gate it behind a confirmation. */
  edited: Record<string, unknown>;
  /** "section.key" paths present in both pendingPatch and serverChangedKeys — the admin's edit and the server's own change touched the same field. */
  overlapping: string[];
}

// deepMerge applies a sparse merge-patch object on top of a base object,
// recursively for nested plain objects — mirrors Telemt's own PATCH
// semantics (07-telemt-sdk.md: "deep-merge таблиц") and buildConfigPatch's
// diffing convention: a patch leaf that's a plain object merges into the
// matching base object; anything else (a new value, an array, a scalar)
// replaces the base's value at that key wholesale.
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const patchValue = patch[key];
    const baseValue = base[key];
    result[key] = isPlainObject(patchValue) && isPlainObject(baseValue) ? deepMerge(baseValue, patchValue) : patchValue;
  }
  return result;
}

// flattenPatchPaths walks a sparse merge-patch object (as produced by
// configPatch.helpers.ts's buildConfigPatch) into its leaf "section.key"
// paths — every key buildConfigPatch actually included, one path each.
function flattenPatchPaths(value: unknown, prefix: string, out: string[]): void {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      flattenPatchPaths(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (prefix) out.push(prefix);
}

// rebaseEdits answers "what should the admin's in-progress edit look like
// on top of a freshly re-fetched config" after a 409 revision_conflict —
// the ConflictBanner's core logic (06-ui.md: never silently discard a
// pending edit just because the revision moved). `pendingPatch` is the
// admin's own PATCH body (from buildConfigPatch against their now-stale
// baseline); `serverChangedKeys` is what actually changed server-side
// (diffChangedSectionKeys.ts, old baseline vs the fresh re-fetch).
//
// `edited` is always the deep-merge of `pendingPatch` onto `freshBase` —
// the admin's edits win over freshBase wherever they touch a key, exactly
// like a normal edit session would if it had started from freshBase in
// the first place. `overlapping` reports which of the admin's own changed
// keys also changed server-side, so the caller can decide whether that
// merge is safe to apply immediately (no overlap — reapplying can't have
// silently clobbered someone else's concurrent change) or needs an
// explicit "apply mine anyway vs discard mine" choice from the admin
// (overlap — reapplying WOULD clobber the server's own change to that
// exact field).
export function rebaseEdits(
  freshBase: Record<string, unknown>,
  pendingPatch: Record<string, unknown>,
  serverChangedKeys: string[],
): RebaseResult {
  const pendingKeys: string[] = [];
  flattenPatchPaths(pendingPatch, "", pendingKeys);
  const serverSet = new Set(serverChangedKeys);
  const overlapping = pendingKeys.filter((k) => serverSet.has(k)).sort();
  return { edited: deepMerge(freshBase, pendingPatch), overlapping };
}
