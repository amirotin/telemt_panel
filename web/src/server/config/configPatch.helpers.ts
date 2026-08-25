import { isPlainObject, valuesEqual } from "./configObjectDiff";

// buildConfigPatch computes the minimal PATCH body for Telemt's
// PATCH /v1/config (07-telemt-sdk.md §Config: "deep-merge таблиц,
// wholesale-замена массивов/скаляров"): only the leaf keys whose value
// actually changed from `original` are included, nested objects diff
// recursively (mirroring Telemt's own per-table deep-merge), while an
// array or scalar is compared by value and, if different, sent whole
// (Telemt replaces arrays/scalars wholesale, it never merges them).
//
// Deliberately one-directional: a key present in `original` but removed
// from `edited` is never emitted as a deletion. Unlike the user PATCH
// endpoint (07-telemt-sdk.md: omitted = keep, `null` = remove), the config
// section PATCH has no documented per-key removal semantics — sending
// `null` for a config key isn't specified anywhere as "unset this", so
// this UI can only add/change config keys, never remove one. A field the
// admin genuinely wants gone has to be removed by editing the config
// through another route (07's `file`-mode config editing, not implemented
// this release) or directly at the Telemt end.
//
// Numbers pass through untouched — values already come from a parsed
// GET /api/telemt/config response and form inputs write back plain JS
// numbers (Number(input.value), never a string), so nothing here
// re-serializes an integer through a string round trip that could nudge it
// toward a float. This still inherits the browser JSON/JS-number ceiling
// (exact integers only below 2^53) — see the task report's own note on
// that inherent limitation.
export function buildConfigPatch(
  original: Record<string, unknown>,
  edited: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const section of Object.keys(edited)) {
    const originalSection = isPlainObject(original[section]) ? original[section] : {};
    const sectionPatch = diffObject(originalSection, edited[section]);
    if (sectionPatch !== undefined) {
      patch[section] = sectionPatch;
    }
  }
  return patch;
}

// diffObject returns undefined when nothing under `edited` differs from
// `original` (so the caller can drop an unchanged section/table entirely),
// otherwise a sparse object holding only the changed leaves.
function diffObject(original: Record<string, unknown>, edited: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(edited)) return undefined;

  const out: Record<string, unknown> = {};
  let changed = false;
  for (const key of Object.keys(edited)) {
    const editedValue = edited[key];
    const originalValue = original[key];
    if (isPlainObject(editedValue) && isPlainObject(originalValue)) {
      const nested = diffObject(originalValue, editedValue);
      if (nested !== undefined) {
        out[key] = nested;
        changed = true;
      }
    } else if (!valuesEqual(originalValue, editedValue)) {
      out[key] = editedValue;
      changed = true;
    }
  }
  return changed ? out : undefined;
}

// getSectionField/setSectionField are the small helpers the Quick Settings
// form uses to read/write one known field inside a `sections` map without
// every call site re-deriving the "section might not exist yet, might not
// be an object" guard.
export function getSectionField(sections: Record<string, unknown>, section: string, key: string): unknown {
  const s = sections[section];
  return isPlainObject(s) ? s[key] : undefined;
}

export function setSectionField(
  sections: Record<string, unknown>,
  section: string,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const current = sections[section];
  const base: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  base[key] = value;
  return { ...sections, [section]: base };
}
