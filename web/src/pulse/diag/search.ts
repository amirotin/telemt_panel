export interface DetailSearch {
  entity?: string;
  tab?: string;
}

const MAX_SEARCH_VALUE_LENGTH = 256;

function searchString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, MAX_SEARCH_VALUE_LENGTH);
  return normalized === "" ? undefined : normalized;
}

export function validateDetailSearch(search: Record<string, unknown>): DetailSearch {
  const entity = searchString(search["entity"]);
  const tab = searchString(search["tab"]);
  return {
    ...(entity !== undefined ? { entity } : {}),
    ...(tab !== undefined ? { tab } : {}),
  };
}
