// The renderer-side view of the recursive node tree §11.3 / §24.1 describes.
//
// The tree itself is built by resolveSections.ts's `buildUnknownNodes` —
// this module does NOT reimplement it. It supplies the two things a
// renderer needs on top: a way to build the same tree for an arbitrary
// value (a record card inside an ArraySection), and the counts/labels the
// accordion headers show.
//
// What is deliberately absent: pulse/diag/rows.ts's `flattenToRows`. That
// helper comma-joins a primitive array into one row and renders an empty
// container as an em dash — both forbidden by §10.1 and §10.3, and both
// exactly the "2003 KV rows" problem this builder exists to replace. The
// last fallback level here is the raw JSON dump §24.1 asks for, not a
// flattened row list.

import type { ClassifyContext, UnknownNode } from "../resolveSections";
import { buildUnknownNodes, unknownLeaves } from "../resolveSections";
import { splitPath } from "../paths";

/**
 * Build the node tree for ANY value — the record-card case, where nothing
 * has been consumed yet and every leaf must appear.
 */
export function buildValueNodes(
  value: unknown,
  path: string,
  ctx: ClassifyContext = {},
): UnknownNode[] {
  const segments = splitPath(path);
  const key = segments[segments.length - 1] ?? "";
  return buildUnknownNodes(value, path, key, () => true, ctx);
}

/**
 * The nodes INSIDE one record, without the record's own wrapper — what a
 * detail surface shows (§9.3: "все остальные поля показываются в
 * AdaptiveDetailSurface", as a flat list of described rows).
 */
export function buildRecordNodes(
  value: unknown,
  path: string,
  ctx: ClassifyContext = {},
): UnknownNode[] {
  const nodes = buildValueNodes(value, path, ctx);
  const only = nodes.length === 1 ? nodes[0] : undefined;
  return only !== undefined && only.kind === "group" ? only.children : nodes;
}

/** How many leaves a node covers — the number its accordion badge shows. */
export function countNodeLeaves(nodes: readonly UnknownNode[]): number {
  return unknownLeaves(nodes as UnknownNode[]).length;
}

/** Leaves under ONE node, for a nested accordion's own badge. */
export function countLeaves(node: UnknownNode): number {
  return countNodeLeaves([node]);
}

// nodeLabel is what a nested block is called. Container nodes are named by
// their key with the spec's array suffix (`endpoints[]`, §10's own
// notation); an element of an array is named by its index.
export function nodeLabel(node: UnknownNode): string {
  const key = node.key === "" ? node.path : node.key;
  if (/^\d+$/.test(key)) {
    const parent = splitPath(node.path);
    const name = parent[parent.length - 2];
    return name === undefined ? `[${key}]` : `${name}[${key}]`;
  }
  return node.kind === "array" ? `${key}[]` : key;
}

// fieldLabel is the name a scalar row shows when the catalog has no
// explicit label: the LAST segment of the normalized path, verbatim.
// Telemt's own field names are what the renders show (`available_pct`,
// `fresh_coverage_pct`) and what an operator greps the Telemt source for —
// humanizing them into prose would make the panel and the proxy disagree
// about what a field is called. An index segment keeps its bracket, so
// `endpoints[0]` reads as an element and not as a stray `0`.
export function fieldLabel(path: string): string {
  const segments = splitPath(path);
  const last = segments[segments.length - 1];
  if (last === undefined) return path;
  if (!/^\d+$/.test(last)) return last;
  const parent = segments[segments.length - 2];
  return parent === undefined ? `[${last}]` : `${parent}[${last}]`;
}
