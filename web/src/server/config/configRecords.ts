

export function pathLeaf(path: string): string {
  return path.split(".").at(-1)?.replace("[]", "") ?? path;
}

export function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}
