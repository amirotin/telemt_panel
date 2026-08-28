import { useStrings } from "../../../i18n";
import type { EntityListSectionDefinition, SectionDefinition } from "../model";
import type { ClassifyContext, SectionInstance } from "../resolveSections";
import { ArraySection } from "./ArraySection";
import { DynamicMapSection } from "./DynamicMapSection";
import { EntityListSection } from "./EntityListSection";
import { ScalarSection } from "./ScalarSection";
import { SectionFrame } from "./SectionFrame";
import { UnknownFieldsSection } from "./UnknownFieldsSection";
import { NodeList } from "./NodeTree";
import { buildValueNodes } from "./unknownFields";
import { isSectionExpanded, showsAtMode, type DetailRenderContext } from "./context";

export interface SectionListProps {
  sections: readonly SectionInstance[];
  /** The declaring definitions, by id — EntityList needs identity/status/highlights. */
  definitions?: ReadonlyMap<string, SectionDefinition<unknown>>;
  ctx: DetailRenderContext;
  /** Page-level search state, used by whichever collection needs a search box. */
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  /** Raw payload, for the unknown tail's JSON fallback. */
  raw?: unknown;
  /** Per-second counter deltas by normalized path (ruling R4). */
  deltas?: Record<string, number>;
}

// SectionList maps resolved instances to renderers, and is the ONE place
// display-mode visibility is applied (`showsAtMode`) — no renderer repeats
// the check and no page adds an ad-hoc one.
export function SectionList({
  sections,
  definitions,
  ctx,
  searchQuery,
  onSearchChange,
  raw,
  deltas,
}: SectionListProps) {
  const visible = sections.filter((section) => showsAtMode(section.minMode, ctx.mode));
  return (
    <div className="flex flex-col gap-3">
      {visible.map((section) => (
        <SectionView
          key={section.id}
          section={section}
          {...(definitions?.get(section.id) !== undefined
            ? { definition: definitions.get(section.id) as SectionDefinition<unknown> }
            : {})}
          ctx={ctx}
          {...(searchQuery !== undefined ? { searchQuery } : {})}
          {...(onSearchChange !== undefined ? { onSearchChange } : {})}
          {...(raw !== undefined ? { raw } : {})}
          {...(deltas !== undefined ? { deltas } : {})}
        />
      ))}
    </div>
  );
}

function SectionView({
  section,
  definition,
  ctx,
  searchQuery,
  onSearchChange,
  raw,
  deltas,
}: {
  section: SectionInstance;
  definition?: SectionDefinition<unknown>;
  ctx: DetailRenderContext;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  raw?: unknown;
  deltas?: Record<string, number>;
}) {
  switch (section.kind) {
    case "scalars":
      return <ScalarSection instance={section} ctx={ctx} />;
    case "entityList":
      return (
        <EntityListSection
          instance={section}
          {...(definition?.kind === "entityList"
            ? { definition: definition as EntityListSectionDefinition<unknown, unknown> }
            : {})}
          ctx={ctx}
          {...(searchQuery !== undefined ? { searchQuery } : {})}
          {...(onSearchChange !== undefined ? { onSearchChange } : {})}
        />
      );
    case "array":
    case "breakdown":
    case "timeline":
    case "ranking":
      // Task 4 gives breakdown/timeline/ranking their own semantic
      // renderers. Until then they render as honest lists rather than
      // disappearing — §10's rule holds either way.
      return <ArraySection instance={section} ctx={ctx} />;
    case "dynamicMap":
      return (
        <DynamicMapSection
          instance={section}
          ctx={ctx}
          {...(deltas !== undefined ? { deltas } : {})}
        />
      );
    case "unknownFields":
      return <UnknownFieldsSection instance={section} ctx={ctx} {...(raw !== undefined ? { raw } : {})} />;
    case "custom":
      return <CustomSectionFallback section={section} ctx={ctx} />;
  }
}

// CustomSectionFallback keeps a custom section's data on screen until its
// domain renderer exists (Task 4's renderer registry). Showing the value
// through the generic node tree is the only option that does not silently
// drop fields the completeness checkpoint counts as consumed.
function CustomSectionFallback({
  section,
  ctx,
}: {
  section: Extract<SectionInstance, { kind: "custom" }>;
  ctx: DetailRenderContext;
}) {
  const s = useStrings();
  const classifyCtx: ClassifyContext = {
    ...(ctx.lookup.catalog !== undefined ? { catalog: ctx.lookup.catalog } : {}),
    ...(ctx.lookup.endpoint !== undefined ? { endpoint: ctx.lookup.endpoint } : {}),
  };
  return (
    <SectionFrame
      id={section.id}
      title={section.title(s)}
      description={section.description?.(s)}
      expanded={isSectionExpanded(section.id, section.defaultExpanded, ctx.expandedSections)}
      onToggle={() => ctx.toggleSection(section.id)}
    >
      <NodeList nodes={buildValueNodes(section.value, section.path, classifyCtx)} ctx={ctx} />
    </SectionFrame>
  );
}
