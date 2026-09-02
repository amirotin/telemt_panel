import type { TelemtConfigCatalog, TelemtConfigField } from "../../lib/api/generated/types.gen";

export interface ConfigChangeEntry {
  path: string;
  before: unknown;
  after: unknown;
  arrayReplacement: boolean;
  field?: TelemtConfigField;
}

export function configChangeEntries(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  catalog: TelemtConfigCatalog,
): ConfigChangeEntry[] {
  const entries: ConfigChangeEntry[] = [];
  collectChanges(before, after, "", catalog, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function concreteToCatalogPath(path: string): string {
  return path.replaceAll(/\[\d+\]/g, "[]");
}

function collectChanges(
  before: unknown,
  after: unknown,
  path: string,
  catalog: TelemtConfigCatalog,
  entries: ConfigChangeEntry[],
) {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) || Array.isArray(after)) {
    if (deepEqual(before, after)) return;
    entries.push(changeEntry(path, before, after, true, catalog));
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      collectChanges(
        before[key],
        after[key],
        path ? `${path}.${key}` : key,
        catalog,
        entries,
      );
    }
    return;
  }
  entries.push(changeEntry(path, before, after, false, catalog));
}

function changeEntry(
  path: string,
  before: unknown,
  after: unknown,
  arrayReplacement: boolean,
  catalog: TelemtConfigCatalog,
): ConfigChangeEntry {
  const catalogPath = concreteToCatalogPath(path);
  const field = catalog.fields.find((candidate) =>
    arrayReplacement
      ? candidate.path === catalogPath || candidate.path.startsWith(`${catalogPath}[].`) || candidate.path.startsWith(`${catalogPath}.`)
      : candidate.path === catalogPath,
  );
  return { path, before, after, arrayReplacement, field };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
