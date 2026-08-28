import { fill, useStrings } from "../../../i18n";
import { Button } from "../../../ui/Button";
import type { UnknownNode } from "../resolveSections";
import { DEFAULT_PAGING } from "../model";
import { FieldRow } from "./FieldRow";
import { SectionFrame } from "./SectionFrame";
import { isSectionExpanded, type DetailRenderContext } from "./context";
import { countLeaves, fieldLabel, nodeLabel } from "./unknownFields";

// The §10.5 "1–8 → полный список" row: a small block opens by default, a
// larger one waits to be asked for.
const OPEN_BY_DEFAULT_LEAVES = 8;

export interface NodeListProps {
  nodes: readonly UnknownNode[];
  ctx: DetailRenderContext;
}

// NodeList renders the recursive tree of §11.3: an object stays a nested
// group, an array stays its own block (never a scalar row, never a
// comma-joined string), and only a scalar becomes a described row. It is
// used both by UnknownFieldsSection (the resolver's leftover tail) and by
// ArraySection's record cards, so a nested value looks the same wherever
// it is found.
export function NodeList({ nodes, ctx }: NodeListProps) {
  const containers = nodes.filter((n) => n.kind !== "row");
  const rows = nodes.filter((n) => n.kind === "row");
  return (
    <>
      {rows.map((node) => (
        <NodeView key={node.path} node={node} ctx={ctx} />
      ))}
      {containers.length > 0 && (
        <div className="flex flex-col gap-2 py-2">
          {containers.map((node) => (
            <NodeView key={node.path} node={node} ctx={ctx} />
          ))}
        </div>
      )}
    </>
  );
}

function NodeView({ node, ctx }: { node: UnknownNode; ctx: DetailRenderContext }) {
  const s = useStrings();

  if (node.kind === "row") {
    return <FieldRow path={node.path} value={node.value} present ctx={ctx} />;
  }

  const leaves = countLeaves(node);
  const defaultExpanded = leaves > 0 && leaves <= OPEN_BY_DEFAULT_LEAVES;
  const expanded = isSectionExpanded(node.path, defaultExpanded, ctx.expandedRecords);
  const toggle = () => ctx.toggleRecord(node.path);

  if (node.kind === "group") {
    // An element of an array is a record CARD (§10.2): always open, titled
    // by its index. A named object is a nested accordion (§11.3).
    const isElement = /^\d+$/.test(node.key);
    return (
      <SectionFrame
        nested
        id={node.path}
        title={nodeLabel(node)}
        count={leaves}
        collapsible={!isElement}
        expanded={isElement ? true : expanded}
        onToggle={toggle}
      >
        {node.children.length === 0 ? (
          <EmptyNote text={s.details.collection.emptyRecord} />
        ) : (
          <NodeList nodes={node.children} ctx={ctx} />
        )}
      </SectionFrame>
    );
  }

  if (node.kind === "map") {
    return (
      <SectionFrame
        nested
        id={node.path}
        title={nodeLabel(node)}
        count={leaves}
        expanded={expanded}
        onToggle={toggle}
      >
        {node.entries.map((entry) => (
          <FieldRow key={entry.path} path={entry.path} value={entry.value} present ctx={ctx} label={entry.key} />
        ))}
        {node.children.length > 0 && <NodeList nodes={node.children} ctx={ctx} />}
      </SectionFrame>
    );
  }

  // array
  return (
    <SectionFrame
      nested
      id={node.path}
      title={nodeLabel(node)}
      count={node.items.length}
      expanded={node.presence === "empty" ? true : expanded}
      collapsible={node.presence !== "empty"}
      onToggle={toggle}
    >
      {node.presence === "empty" ? (
        <EmptyNote text={s.details.collection.emptyTitle} />
      ) : node.primitives ? (
        <PrimitiveList node={node} ctx={ctx} />
      ) : (
        <PagedChildren id={node.path} items={node.children} ctx={ctx} />
      )}
    </SectionFrame>
  );
}

// PrimitiveList is §10.1: one row per element, each element fully readable.
// A comma-joined string is forbidden, and so is "N items".
function PrimitiveList({
  node,
  ctx,
}: {
  node: Extract<UnknownNode, { kind: "array" }>;
  ctx: DetailRenderContext;
}) {
  return (
    <>
      {node.children.map((child) =>
        child.kind === "row" ? (
          <FieldRow
            key={child.path}
            path={child.path}
            value={child.value}
            present
            ctx={ctx}
            label={fieldLabel(child.path)}
          />
        ) : (
          <NodeView key={child.path} node={child} ctx={ctx} />
        ),
      )}
    </>
  );
}

// PagedChildren is progressive reveal (§10.5, §18.3) — first 20, then
// «Показать ещё». Never numbered pages, and the reveal only ever grows.
function PagedChildren({
  id,
  items,
  ctx,
}: {
  id: string;
  items: readonly UnknownNode[];
  ctx: DetailRenderContext;
}) {
  const s = useStrings();
  const limit = ctx.visibleLimit(id, DEFAULT_PAGING.initial);
  const shown = items.slice(0, limit);
  return (
    <>
      {shown.map((child) => (
        <NodeView key={child.path} node={child} ctx={ctx} />
      ))}
      {items.length > shown.length && (
        <RevealMore
          shown={shown.length}
          total={items.length}
          onReveal={() => ctx.revealMore(id, DEFAULT_PAGING.step, DEFAULT_PAGING.initial)}
          label={s.details.collection.showMore}
          countLabel={fill(s.details.collection.shownTemplate, {
            shown: String(shown.length),
            total: String(items.length),
          })}
        />
      )}
    </>
  );
}

export function RevealMore({
  shown,
  total,
  onReveal,
  label,
  countLabel,
}: {
  shown: number;
  total: number;
  onReveal: () => void;
  label: string;
  countLabel: string;
}) {
  if (shown >= total) return null;
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-micro tabular-nums text-text-faint">{countLabel}</span>
      <Button variant="secondary" size="sm" onClick={onReveal}>
        {label}
      </Button>
    </div>
  );
}

// EmptyNote — "the field is here and it is empty", which §10.3 requires to
// look different from a field that never arrived.
export function EmptyNote({ text }: { text: string }) {
  return <p className="py-3 text-meta text-text-muted">{text}</p>;
}
