// resolveSections — spec §12's renderer-selection algorithm, as one pure
// function.
//
//   1. take the page definition and the payload
//   2. (source state is decided in sources.ts, applied by the page)
//   3. take the already-selected entity/context
//   4. instantiate the explicitly configured sections
//   5. mark the normalized paths they consume
//   6. classify everything left over: array / stable object / dynamic map /
//      scalar
//   7. NEVER hand an array to a ScalarRow
//   8. show the unknown tail only when unconsumed paths remain
//
// The output is data, not React: every renderer in Task 3/4 takes a
// SectionInstance. That is what makes the completeness guarantee (ruling
// R7, spec §27.4) a unit test over fixtures rather than a DOM crawl —
//
//     all leaves − consumed − explicitly ignored − unknown tail = ∅
//
// and what makes "нет ли потерянных полей" answerable in CI from task 2
// onwards, before a single pixel exists.

import type {
  DetailPageDefinition,
  FieldUnit,
  PagingPolicy,
  SectionDefinition,
  SectionKind,
  UnknownFieldsPolicy,
} from "./model";
import type { FormatterName } from "./formatting";
import { DEFAULT_PAGING, DEFAULT_UNKNOWN_FIELDS_POLICY, pagingForSize } from "./model";
import type { DisplayMode } from "../../display-mode/mode";
import type { Localized } from "./model";
import { childPath, indexPath, isUnderPath, readPath, hasPath, walkLeafPaths } from "./paths";
import { lookupField } from "./fieldCatalog";
import type { FieldCatalog, FieldLookupContext } from "./fieldCatalog";

// --- value classification (§12.6, §11) ----------------------------------

export type ValueClass =
  | "primitiveArray"
  | "recordArray"
  | "dynamicMap"
  | "object"
  | "scalar"
  | "null"
  | "absent";

/** What classifyValue needs to tell a counters map from a typed record. */
export interface ClassifyContext {
  /** Normalized path of the value being classified; "" for the whole context. */
  path?: string;
  /** Source id for the catalog's endpoint-scoped rules (R9). */
  endpoint?: string;
  catalog?: FieldCatalog;
}

// classifyValue is step 6's dispatcher. The only judgement call is
// dynamic-map-vs-object, and it is made on three criteria, because a single
// "are all the values numbers" test gets it wrong in BOTH directions on real
// payloads (task-2 review, M1):
//
//   (a) at least two keys — a one-key object is not a map worth showing as
//       verbatim keys;
//   (b) once nested objects and arrays are set aside, at least two leaves
//       remain and they are ALL numeric. Setting nesting aside is what makes
//       `zero/all`'s `core` (21 counters plus two {class,total} arrays) and
//       `middle_proxy` (54 counters plus an empty handshake_error_codes) come
//       out as the counters maps they are; the nested containers are then
//       resolved separately as their own blocks, never folded into a row;
//   (c) NO key resolves in the field catalog by exact, endpoint-scoped or
//       wildcard rule. This is the discriminator a value test cannot supply:
//       `RuntimeMeQualityDcRtt` ({dc, rtt_ema_ms, alive_writers,
//       required_writers, coverage_pct}) is all-numeric too, but it is a
//       typed record with descriptions, and §11.2's verbatim-key rule exists
//       for keys nobody has described — counter keys, which fall through to
//       the counters-family rule at most.
//
// A page definition can always force either reading by declaring the section
// explicitly; this is only what happens when nothing was declared.
export function classifyValue(value: unknown, ctx: ClassifyContext = {}): ValueClass {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "primitiveArray";
    return value.some((v) => v !== null && typeof v === "object") ? "recordArray" : "primitiveArray";
  }
  if (typeof value === "object") {
    return isDynamicMap(value as Record<string, unknown>, ctx) ? "dynamicMap" : "object";
  }
  return "scalar";
}

function isDynamicMap(record: Record<string, unknown>, ctx: ClassifyContext): boolean {
  const entries = Object.entries(record).filter(([, v]) => v !== undefined);
  // (a)
  if (entries.length < 2) return false;
  // (b)
  const scalars = entries.filter(([, v]) => v === null || typeof v !== "object");
  if (scalars.length < 2) return false;
  if (!scalars.every(([, v]) => typeof v === "number")) return false;
  // (c)
  const base = ctx.path ?? "";
  const lookupCtx: FieldLookupContext = {
    ...(ctx.endpoint !== undefined ? { endpoint: ctx.endpoint } : {}),
    ...(ctx.catalog !== undefined ? { catalog: ctx.catalog } : {}),
  };
  for (const [key] of scalars) {
    const source = lookupField(childPath(base, key), lookupCtx).source;
    if (source === "exact" || source === "endpoint" || source === "wildcard") return false;
  }
  return true;
}

// --- resolved instances --------------------------------------------------

/** Whether a collection arrived empty or never arrived at all (§10.3). */
export type CollectionPresence = "present" | "empty" | "absent";

export interface SectionInstanceCommon {
  id: string;
  title: Localized;
  description?: Localized;
  sourceId?: string;
  minMode?: DisplayMode;
  defaultExpanded: boolean;
  /** Normalized path this section is rooted at ("" for a whole-context section). */
  path: string;
  /** Every leaf path this instance renders — the consumed set for §27.4. */
  consumed: string[];
}

/**
 * One scalar row. Invariant (§12.7): `value` is never an array and never a
 * plain object — the resolver extracts those into their own sections before
 * a row is ever built.
 */
export interface ScalarRow {
  path: string;
  /** `undefined` means the key never arrived; `null` means it arrived null (§13.1). */
  value: string | number | boolean | null | undefined;
  /** False when the key is absent from the payload — distinct from a null value (§13.1). */
  present: boolean;
  /**
   * Per-BINDING formatter/unit override (§13: "formatter выбирается по field
   * catalog ИЛИ binding"). Carried on the row because the renderer never
   * sees the definition — without it a definition could declare an override
   * the row would silently drop, and an epoch field would render through the
   * counters-family `_secs` rule as a duration.
   */
  format?: FormatterName;
  unit?: FieldUnit;
}

export interface ScalarSectionInstance extends SectionInstanceCommon {
  kind: "scalars";
  rows: ScalarRow[];
}

export interface CollectionSectionInstance extends SectionInstanceCommon {
  kind: "array" | "entityList" | "breakdown" | "timeline" | "ranking";
  items: unknown[];
  itemKeys: string[];
  presence: CollectionPresence;
  /** True for `["a","b"]`, false for `[{…},{…}]` — drives compact list vs record cards (§10.1/10.2). */
  primitives: boolean;
  paging: PagingPolicy;
  searchRequired: boolean;
}

export interface DynamicMapEntry {
  path: string;
  key: string;
  value: unknown;
}

/**
 * A container found INSIDE a counters map (`core.connections_bad_by_class`).
 * §11.2 shows map keys verbatim, but a nested array is still an array: it
 * gets its own block rather than a row, which is criterion (b) of
 * classifyValue made visible to the renderer.
 */
export interface DynamicMapNested {
  path: string;
  key: string;
  value: unknown;
  valueClass: ValueClass;
}

export interface DynamicMapGroupInstance {
  id: string;
  title?: Localized;
  /** Scalar leaves only — the verbatim key/value rows. */
  entries: DynamicMapEntry[];
  /** Objects and arrays nested in the map, resolved as their own blocks. */
  nested: DynamicMapNested[];
}

export interface DynamicMapSectionInstance extends SectionInstanceCommon {
  kind: "dynamicMap";
  groups: DynamicMapGroupInstance[];
  supportsDelta: boolean;
}

export interface CustomSectionInstance extends SectionInstanceCommon {
  kind: "custom";
  renderer: string;
  value: unknown;
}

// UnknownNode is the recursive shape §11.3/§24.1 describes: objects stay
// groups, arrays stay array blocks, scalars become described rows. Nothing
// is flattened here — flattenToRows is allowed only inside the explicitly
// opened raw fallback (§12's closing note).
export type UnknownNode =
  | { kind: "group"; path: string; key: string; children: UnknownNode[] }
  | {
      kind: "array";
      path: string;
      key: string;
      items: unknown[];
      primitives: boolean;
      presence: CollectionPresence;
      children: UnknownNode[];
    }
  | {
      kind: "map";
      path: string;
      key: string;
      entries: DynamicMapEntry[];
      children: UnknownNode[];
    }
  | { kind: "row"; path: string; key: string; value: string | number | boolean | null };

export interface UnknownFieldsSectionInstance extends SectionInstanceCommon {
  kind: "unknownFields";
  nodes: UnknownNode[];
  rawJson: boolean;
  /** Flat list of the leaves in this tail — the third term of the §27.4 equation. */
  leafPaths: string[];
}

export type SectionInstance =
  | ScalarSectionInstance
  | CollectionSectionInstance
  | DynamicMapSectionInstance
  | CustomSectionInstance
  | UnknownFieldsSectionInstance;

export interface IgnoredPath {
  path: string;
  reason: string;
}

export interface ResolveResult {
  sections: SectionInstance[];
  /** Present only when unconsumed paths remain (§12.8). */
  unknownFields: UnknownFieldsSectionInstance | null;
  /** Every leaf the context carries. */
  allPaths: string[];
  /** Leaves rendered by an explicitly configured section. */
  consumedPaths: string[];
  /** Leaves dropped by policy, each with its reason (§24.2). */
  ignoredPaths: IgnoredPath[];
  /** Leaves rendered by the unknown tail. */
  unknownPaths: string[];
  /**
   * Leaves accounted for by none of the three — MUST be empty (§27.4).
   * Exposed rather than asserted internally so the completeness test can
   * name the offending paths.
   */
  lostPaths: string[];
  /**
   * Paths a ScalarSection declared that turned out to hold an array or an
   * object. §9.1 says they are extracted before render; they end up in the
   * unknown tail rather than in a scalar row, and are reported here so a
   * page definition can be corrected instead of silently mis-rendering.
   */
  extractedFromScalars: string[];
}

// --- helpers -------------------------------------------------------------

// isScalar accepts `undefined` too: an absent optional field is still a
// scalar ROW (it renders as "не пришло в ответе", §13.1), it is only a
// container that must be extracted out of a ScalarSection.
function isScalar(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

function leafPathsUnder(context: unknown, path: string): string[] {
  const value = path === "" ? context : readPath(context, path);
  if (value === undefined) return [];
  return walkLeafPaths(value, path).map((l) => l.path);
}

function collectionKind(kind: SectionKind): CollectionSectionInstance["kind"] | null {
  switch (kind) {
    case "array":
    case "entityList":
    case "breakdown":
    case "timeline":
    case "ranking":
      return kind;
    default:
      return null;
  }
}

function mergePaging(policy: Partial<PagingPolicy> | undefined): PagingPolicy {
  return { ...DEFAULT_PAGING, ...(policy ?? {}) };
}

// --- section instantiation (step 4) -------------------------------------

function resolveScalarSection<T>(
  section: Extract<SectionDefinition<T>, { kind: "scalars" }>,
  context: T,
  extracted: string[],
): ScalarSectionInstance {
  const rows: ScalarRow[] = [];
  const consumed: string[] = [];
  for (const field of section.fields) {
    const value = field.select ? field.select(context) : readPath(context, field.path);
    // §9.1 + §12.7: a binding that turns out to be a container is EXTRACTED,
    // not stringified. Its leaves stay unconsumed, so the generic fallback
    // picks them up as a proper array/object block further down.
    if (!isScalar(value)) {
      if (value !== undefined) extracted.push(field.path);
      continue;
    }
    rows.push({
      path: field.path,
      value,
      present: field.select ? value !== undefined : hasPath(context, field.path),
      ...(field.format !== undefined ? { format: field.format } : {}),
      ...(field.unit !== undefined ? { unit: field.unit } : {}),
    });
    consumed.push(field.path);
  }
  return {
    kind: "scalars",
    id: section.id,
    title: section.title,
    ...(section.description ? { description: section.description } : {}),
    ...(section.sourceId ? { sourceId: section.sourceId } : {}),
    ...(section.minMode ? { minMode: section.minMode } : {}),
    defaultExpanded: section.defaultExpanded ?? true,
    path: "",
    consumed,
    rows,
  };
}

function resolveCollectionSection<T>(
  section: SectionDefinition<T> & { path: string },
  kind: CollectionSectionInstance["kind"],
  context: T,
): CollectionSectionInstance {
  const raw = section.select ? section.select(context) : readPath(context, section.path);
  const present = section.select ? raw !== undefined : hasPath(context, section.path);
  const items = Array.isArray(raw) ? raw : [];
  const presence: CollectionPresence = !present || raw === undefined || raw === null
    ? "absent"
    : items.length === 0
      ? "empty"
      : "present";
  const keyer =
    "itemKey" in section && typeof section.itemKey === "function"
      ? (section.itemKey as (item: unknown, index: number) => string)
      : (_item: unknown, index: number) => String(index);
  const paging = mergePaging("paging" in section ? section.paging : undefined);
  const sizing = pagingForSize(items.length, paging);
  return {
    kind,
    id: section.id,
    title: section.title,
    ...(section.description ? { description: section.description } : {}),
    ...(section.sourceId ? { sourceId: section.sourceId } : {}),
    ...(section.minMode ? { minMode: section.minMode } : {}),
    defaultExpanded: section.defaultExpanded ?? sizing.expandedByDefault,
    path: section.path,
    // A section bound to a path OWNS that path once the key exists — even
    // when the value arrived as null, which is a leaf of its own and must
    // not drift into the unknown tail.
    consumed: present ? leafPathsUnder(context, section.path) : [],
    items,
    itemKeys: items.map((item, i) => keyer(item, i)),
    presence,
    primitives: items.length > 0 && !items.some((v) => v !== null && typeof v === "object"),
    paging,
    searchRequired: sizing.searchRequired,
  };
}

interface MapSplit {
  entries: DynamicMapEntry[];
  nested: DynamicMapNested[];
}

// splitMap separates a counters map's scalar leaves (verbatim key/value rows)
// from the containers nested inside it. Keeping the two apart is what stops a
// nested {class,total} array from being handed to a row renderer as a value.
function splitMap(value: unknown, path: string, ctx: ClassifyContext): MapSplit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { entries: [], nested: [] };
  }
  const entries: DynamicMapEntry[] = [];
  const nested: DynamicMapNested[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    const childPathValue = childPath(path, key);
    if (v !== null && typeof v === "object") {
      nested.push({
        path: childPathValue,
        key,
        value: v,
        valueClass: classifyValue(v, { ...ctx, path: childPathValue }),
      });
      continue;
    }
    entries.push({ path: childPathValue, key, value: v });
  }
  return { entries, nested };
}

function resolveDynamicMapSection<T>(
  section: Extract<SectionDefinition<T>, { kind: "dynamicMap" }>,
  context: T,
  ctx: ClassifyContext,
): DynamicMapSectionInstance {
  const raw = section.select ? section.select(context) : readPath(context, section.path);
  const groups: DynamicMapGroupInstance[] = section.groups
    ? section.groups.map((g) => ({
        id: g.id,
        title: g.title,
        ...splitMap(readPath(context, g.path), g.path, ctx),
      }))
    : [{ id: section.id, ...splitMap(raw, section.path, ctx) }];
  return {
    kind: "dynamicMap",
    id: section.id,
    title: section.title,
    ...(section.description ? { description: section.description } : {}),
    ...(section.sourceId ? { sourceId: section.sourceId } : {}),
    ...(section.minMode ? { minMode: section.minMode } : {}),
    defaultExpanded: section.defaultExpanded ?? false,
    path: section.path,
    consumed: leafPathsUnder(context, section.path),
    groups,
    supportsDelta: section.supportsDelta ?? false,
  };
}

function resolveCustomSection<T>(
  section: Extract<SectionDefinition<T>, { kind: "custom" }>,
  context: T,
): CustomSectionInstance {
  const consumed = section.consumes.flatMap((p) => leafPathsUnder(context, p));
  return {
    kind: "custom",
    id: section.id,
    title: section.title,
    ...(section.description ? { description: section.description } : {}),
    ...(section.sourceId ? { sourceId: section.sourceId } : {}),
    ...(section.minMode ? { minMode: section.minMode } : {}),
    defaultExpanded: section.defaultExpanded ?? true,
    path: section.consumes[0] ?? "",
    consumed,
    renderer: section.renderer,
    value: section.select ? section.select(context) : context,
  };
}

// --- the unknown tail (step 6, §11.3, §24) ------------------------------

// buildUnknownNodes reconstructs the leftover subtree, keeping every
// container a container. `keep` decides membership: a node survives only if
// at least one of its leaves is still unconsumed, which is what stops the
// tail from re-showing a field a real section already rendered.
//
// Exported because it is also the walker the RENDERERS need: an ArraySection
// record card faces the same "objects stay groups, arrays stay array blocks,
// scalars become described rows" problem (§10.4, §11.3), and calling this
// with `keep: () => true` is the one way to be sure a record card and the
// unknown tail agree about what a nested value looks like. See
// renderers/unknownFields.ts.
export function buildUnknownNodes(
  value: unknown,
  path: string,
  key: string,
  keep: (leafPath: string) => boolean,
  ctx: ClassifyContext,
): UnknownNode[] {
  const cls = classifyValue(value, { ...ctx, path });
  if (cls === "absent") return [];
  if (cls === "scalar" || cls === "null") {
    // `cls` already excludes undefined here — an absent key never reaches
    // the tail, it simply does not exist in the payload.
    const scalar = value as string | number | boolean | null;
    return keep(path) ? [{ kind: "row", path, key, value: scalar }] : [];
  }
  if (cls === "primitiveArray" || cls === "recordArray") {
    const items = value as unknown[];
    if (items.length === 0) {
      return keep(path)
        ? [{ kind: "array", path, key, items, primitives: true, presence: "empty", children: [] }]
        : [];
    }
    const children = items.flatMap((item, i) =>
      buildUnknownNodes(item, indexPath(path, i), String(i), keep, ctx),
    );
    if (children.length === 0) return [];
    return [
      {
        kind: "array",
        path,
        key,
        items,
        primitives: cls === "primitiveArray",
        presence: "present",
        children,
      },
    ];
  }
  if (cls === "dynamicMap") {
    const split = splitMap(value, path, ctx);
    const entries = split.entries.filter((e) => keep(e.path));
    // A container nested in a counters map keeps its own shape (§11.2 covers
    // the KEYS, not the nesting) — it becomes a child block, never a row.
    const children = split.nested.flatMap((n) =>
      buildUnknownNodes(n.value, n.path, n.key, keep, ctx),
    );
    if (entries.length === 0 && children.length === 0) return [];
    return [{ kind: "map", path, key, entries, children }];
  }
  // stable object
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined);
  if (keys.length === 0) {
    return keep(path) ? [{ kind: "group", path, key, children: [] }] : [];
  }
  const children = keys.flatMap((k) =>
    buildUnknownNodes(record[k], childPath(path, k), k, keep, ctx),
  );
  if (children.length === 0) return [];
  return [{ kind: "group", path, key, children }];
}

export function unknownLeaves(nodes: UnknownNode[]): string[] {
  const out: string[] = [];
  const walk = (node: UnknownNode) => {
    switch (node.kind) {
      case "row":
        out.push(node.path);
        return;
      case "map":
        for (const e of node.entries) out.push(e.path);
        node.children.forEach(walk);
        return;
      case "array":
        if (node.presence === "empty") {
          out.push(node.path);
          return;
        }
        node.children.forEach(walk);
        return;
      case "group":
        if (node.children.length === 0) {
          out.push(node.path);
          return;
        }
        node.children.forEach(walk);
    }
  };
  nodes.forEach(walk);
  return out;
}

// --- the algorithm -------------------------------------------------------

export interface ResolveOptions<TPayload, TContext> {
  definition: DetailPageDefinition<TPayload, TContext>;
  /** The already-selected entity/context (step 3 happens in state.ts + the page). */
  context: TContext;
  /** Sections below this mode are still resolved; the renderer filters with visibleFor. */
  mode?: DisplayMode;
  /** Overrides the default field catalog — classifyValue consults it (criterion c). */
  catalog?: FieldCatalog;
  /** Source id for the catalog's endpoint-scoped rules (R9). */
  endpoint?: string;
}

// assertIgnoreRules rejects the one input that could quietly switch the R7
// completeness checkpoint off: `{ path: "" }` is "under" every path, so a
// single such rule would mark the WHOLE payload intentionally dropped and
// leave `lostPaths` empty no matter what the resolver did. A reason string is
// required for the same reason §24.2 requires one — a drop nobody can audit
// is a silent drop with extra steps.
function assertIgnoreRules(definition: { id: string }, rules: readonly IgnoredPath[]): void {
  for (const rule of rules) {
    if (rule.path.trim() === "") {
      throw new Error(
        `${definition.id}: unknownFields.ignore rule with an empty path would drop the entire payload`,
      );
    }
    if (rule.reason.trim() === "") {
      throw new Error(`${definition.id}: unknownFields.ignore rule "${rule.path}" has no reason`);
    }
  }
}

export function resolveSections<TPayload, TContext>({
  definition,
  context,
  catalog,
  endpoint,
}: ResolveOptions<TPayload, TContext>): ResolveResult {
  const classifyCtx: ClassifyContext = {
    ...(catalog !== undefined ? { catalog } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
  };
  const allPaths = walkLeafPaths(context).map((l) => l.path);
  const policy: UnknownFieldsPolicy = definition.unknownFields ?? {};
  const ignoreRules = policy.ignore ?? [];
  assertIgnoreRules(definition, ignoreRules);

  const ignoredPaths: IgnoredPath[] = [];
  const ignoredSet = new Set<string>();
  for (const path of allPaths) {
    const rule = ignoreRules.find((r) => isUnderPath(path, r.path));
    if (rule) {
      ignoredPaths.push({ path, reason: rule.reason });
      ignoredSet.add(path);
    }
  }

  // Step 4 — instantiate the configured sections.
  const extractedFromScalars: string[] = [];
  const sections: SectionInstance[] = [];
  for (const section of definition.sections) {
    if (section.kind === "scalars") {
      sections.push(resolveScalarSection(section, context, extractedFromScalars));
      continue;
    }
    if (section.kind === "dynamicMap") {
      sections.push(resolveDynamicMapSection(section, context, classifyCtx));
      continue;
    }
    if (section.kind === "custom") {
      sections.push(resolveCustomSection(section, context));
      continue;
    }
    const kind = collectionKind(section.kind);
    if (kind) sections.push(resolveCollectionSection(section, kind, context));
  }

  // Step 5 — mark consumed paths. `alsoConsumes` lets a section claim a
  // sibling it folded into its own rows without owning the subtree.
  const consumedSet = new Set<string>();
  for (const instance of sections) {
    for (const p of instance.consumed) consumedSet.add(p);
  }
  for (const section of definition.sections) {
    for (const extra of section.alsoConsumes ?? []) {
      for (const p of leafPathsUnder(context, extra)) consumedSet.add(p);
    }
  }

  // Steps 6–8 — everything not consumed and not ignored becomes the tail.
  const keep = (leafPath: string) => !consumedSet.has(leafPath) && !ignoredSet.has(leafPath);
  // The root of the context is not itself a field: unwrap it so the tail is
  // a list of the payload's own top-level groups/arrays/rows rather than one
  // nameless group wrapping everything.
  const roots = buildUnknownNodes(context, "", "", keep, classifyCtx);
  const nodes =
    roots.length === 1 && roots[0].path === "" && roots[0].kind === "group"
      ? roots[0].children
      : roots;
  const unknownPaths = unknownLeaves(nodes);

  let unknownFields: UnknownFieldsSectionInstance | null = null;
  if (unknownPaths.length > 0) {
    unknownFields = {
      kind: "unknownFields",
      id: "unknown-fields",
      // Title/description come from the dictionary at render time; the
      // resolver only knows this section exists.
      title: (s) => s.details.unknown.title,
      description: (s) => s.details.unknown.description,
      // Ruling R2 / spec §30.7: the tail is extended-mode only.
      minMode: policy.minMode ?? DEFAULT_UNKNOWN_FIELDS_POLICY.minMode,
      // §24.1: last, and closed by default.
      defaultExpanded: false,
      path: "",
      consumed: unknownPaths,
      nodes,
      rawJson: policy.rawJson ?? DEFAULT_UNKNOWN_FIELDS_POLICY.rawJson,
      leafPaths: unknownPaths,
    };
    sections.push(unknownFields);
  }

  const consumedPaths = allPaths.filter((p) => consumedSet.has(p));
  const unknownSet = new Set(unknownPaths);
  const lostPaths = allPaths.filter(
    (p) => !consumedSet.has(p) && !ignoredSet.has(p) && !unknownSet.has(p),
  );

  return {
    sections,
    unknownFields,
    allPaths,
    consumedPaths,
    ignoredPaths,
    unknownPaths,
    lostPaths,
    extractedFromScalars,
  };
}
