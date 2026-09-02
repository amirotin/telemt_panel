import type { TelemtConfigField } from "../../lib/api/generated/types.gen";

export interface ConfigFieldInstance {
  field: TelemtConfigField;
  concretePath: string;
  value: unknown;
  recordLabel?: string;
}

interface CatalogSegment {
  key: string;
  array: boolean;
}

function parseCatalogPath(path: string): CatalogSegment[] {
  return path.split(".").map((part) => ({
    key: part.endsWith("[]") ? part.slice(0, -2) : part,
    array: part.endsWith("[]"),
  }));
}

export function fieldInstances(
  sections: Record<string, unknown>,
  field: TelemtConfigField,
): ConfigFieldInstance[] {
  const segments = parseCatalogPath(field.path);
  const instances: ConfigFieldInstance[] = [];

  function visit(
    value: unknown,
    index: number,
    concretePath: string,
    recordParts: string[],
  ) {
    if (index >= segments.length) {
      instances.push({
        field,
        concretePath,
        value,
        recordLabel: recordParts.length > 0 ? recordParts.join(" · ") : undefined,
      });
      return;
    }

    const segment = segments[index];
    const object = isRecord(value) ? value : undefined;
    const child = object?.[segment.key];
    const prefix = concretePath ? `${concretePath}.${segment.key}` : segment.key;

    if (!segment.array) {
      visit(child, index + 1, prefix, recordParts);
      return;
    }

    if (!Array.isArray(child)) return;
    child.forEach((item, itemIndex) => {
      visit(
        item,
        index + 1,
        `${prefix}[${itemIndex}]`,
        [...recordParts, `${segment.key} ${itemIndex + 1}`],
      );
    });
  }

  visit(sections, 0, "", []);
  return instances;
}

export function getConfigValue(root: Record<string, unknown>, concretePath: string): unknown {
  let current: unknown = root;
  for (const token of concretePathTokens(concretePath)) {
    if (typeof token === "number") {
      current = Array.isArray(current) ? current[token] : undefined;
    } else {
      current = isRecord(current) ? current[token] : undefined;
    }
  }
  return current;
}

export function setConfigValue(
  root: Record<string, unknown>,
  concretePath: string,
  value: unknown,
): Record<string, unknown> {
  const tokens = concretePathTokens(concretePath);
  if (tokens.length === 0) return root;

  function setAt(current: unknown, index: number): unknown {
    if (index === tokens.length) return value;
    const token = tokens[index];
    if (typeof token === "number") {
      const next = Array.isArray(current) ? [...current] : [];
      next[token] = setAt(next[token], index + 1);
      return next;
    }
    const next = isRecord(current) ? { ...current } : {};
    next[token] = setAt(next[token], index + 1);
    return next;
  }

  return setAt(root, 0) as Record<string, unknown>;
}

export function catalogFieldMatches(
  field: TelemtConfigField,
  query: string,
  label: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase("ru-RU");
  if (!needle) return true;
  return [field.path, field.data_type, field.default_value, label]
    .join(" ")
    .toLocaleLowerCase("ru-RU")
    .includes(needle);
}

export function isConfigSectionPresent(
  sections: Record<string, unknown>,
  field: TelemtConfigField,
): boolean {
  return Object.hasOwn(sections, field.path.split(".", 1)[0].replace("[]", ""));
}

function concretePathTokens(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  for (const match of path.matchAll(/([^.[]+)|\[(\d+)]/g)) {
    if (match[2] !== undefined) tokens.push(Number(match[2]));
    else if (match[1] !== undefined) tokens.push(match[1]);
  }
  return tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
