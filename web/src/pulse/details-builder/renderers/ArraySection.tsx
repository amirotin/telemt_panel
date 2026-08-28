import { fill, useStrings } from "../../../i18n";
import type { CollectionSectionInstance } from "../resolveSections";
import type { ClassifyContext } from "../resolveSections";
import { indexPath } from "../paths";
import { FieldRow } from "./FieldRow";
import { SectionFrame } from "./SectionFrame";
import { EmptyNote, NodeList, RevealMore } from "./NodeTree";
import { buildValueNodes, fieldLabel } from "./unknownFields";
import { isSectionExpanded, type DetailRenderContext } from "./context";

export interface ArraySectionProps {
  instance: CollectionSectionInstance;
  ctx: DetailRenderContext;
}

// ArraySection is §10 made literal: an array ALWAYS gets its own block.
//
//   - primitives  → a compact list, one row per element (§10.1). Never
//                   comma-joined, never "N items" — the count in the header
//                   badge is an addition to the content, not a substitute.
//   - records     → one record card per element (§10.2), whose nested
//                   arrays become child accordions rather than scalar rows
//                   (§10.4), because the card body is the same NodeList the
//                   unknown tail uses.
//   - empty       → the section stays visible and says so; an ABSENT field
//                   says something different (§10.3).
//
// It is also the generic fallback for the semantic collection kinds
// (breakdown / timeline / ranking) until Task 4 gives each its own
// renderer: rendering them as honest lists is correct-but-plain, and
// strictly better than dropping them.
export function ArraySection({ instance, ctx }: ArraySectionProps) {
  const s = useStrings();
  const expanded = isSectionExpanded(instance.id, instance.defaultExpanded, ctx.expandedSections);
  const classifyCtx: ClassifyContext = {
    ...(ctx.lookup.catalog !== undefined ? { catalog: ctx.lookup.catalog } : {}),
    ...(ctx.lookup.endpoint !== undefined ? { endpoint: ctx.lookup.endpoint } : {}),
  };

  const limit = ctx.visibleLimit(instance.id, instance.paging.initial);
  const shown = instance.items.slice(0, limit);

  return (
    <SectionFrame
      id={instance.id}
      title={instance.title(s)}
      description={instance.description?.(s)}
      {...(instance.presence === "absent" ? {} : { count: instance.items.length })}
      expanded={expanded}
      onToggle={() => ctx.toggleSection(instance.id)}
    >
      {instance.presence === "absent" ? (
        <EmptyNote text={s.details.collection.absentTitle} />
      ) : instance.presence === "empty" ? (
        <EmptyNote text={s.details.collection.emptyTitle} />
      ) : (
        <>
          {shown.map((item, i) =>
            instance.primitives ? (
              <FieldRow
                key={instance.itemKeys[i] ?? String(i)}
                path={indexPath(instance.path, i)}
                value={item}
                present
                ctx={ctx}
                label={fieldLabel(indexPath(instance.path, i))}
              />
            ) : (
              <NodeList
                key={instance.itemKeys[i] ?? String(i)}
                nodes={buildValueNodes(item, indexPath(instance.path, i), classifyCtx)}
                ctx={ctx}
              />
            ),
          )}
          <RevealMore
            shown={shown.length}
            total={instance.items.length}
            onReveal={() =>
              ctx.revealMore(instance.id, instance.paging.step, instance.paging.initial)
            }
            label={s.details.collection.showMore}
            countLabel={fill(s.details.collection.shownTemplate, {
              shown: String(shown.length),
              total: String(instance.items.length),
            })}
          />
        </>
      )}
    </SectionFrame>
  );
}
