import { useMemo } from "react";
import type {
  BreakdownSectionDefinition,
  EntityListSectionDefinition,
  RankingSectionDefinition,
  SectionDefinition,
  TimelineSectionDefinition,
} from "../model";
import type { SectionInstance } from "../resolveSections";
import { ArraySection } from "./ArraySection";
import { BreakdownSection } from "./BreakdownSection";
import { CustomSection } from "./CustomSection";
import { DynamicMapSection } from "./DynamicMapSection";
import { EntityListSection } from "./EntityListSection";
import { RankingSection } from "./RankingSection";
import { ScalarSection } from "./ScalarSection";
import { TimelineSection } from "./TimelineSection";
import { UnknownFieldsSection } from "./UnknownFieldsSection";
import type { CustomSectionRegistry } from "./customRenderers";
import { showsAtMode, type DetailRenderContext } from "./context";

export interface SectionListProps {
  sections: readonly SectionInstance[];
  /** The declaring definitions, by id — the semantic kinds need their accessors. */
  definitions?: ReadonlyMap<string, SectionDefinition<unknown>>;
  ctx: DetailRenderContext;
  /** Page-level search state, used by whichever collection needs a search box. */
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  /** Raw payload, for the unknown tail's JSON fallback. */
  raw?: unknown;
  /** Per-second counter deltas by normalized path (ruling R4). */
  deltas?: Record<string, number>;
  /** Domain chart renderers for CustomSection (§9.8). */
  customRenderers?: CustomSectionRegistry;
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
  customRenderers,
}: SectionListProps) {
  const visible = sections.filter((section) => showsAtMode(section.minMode, ctx.mode));

  // Paths an EXPLICIT section already owns. A dynamic map is bound to a
  // whole subtree ("" for the counters page), so without this a breakdown
  // declared over `core.connections_bad_by_class` would render alongside the
  // very same array shown nested inside the map's `core` group. The explicit
  // section wins; the map hides what it gave away.
  const claimedPaths = useMemo(
    () =>
      new Set(
        sections
          .filter((s) => s.kind !== "dynamicMap" && s.kind !== "unknownFields" && s.path !== "")
          .map((s) => s.path),
      ),
    [sections],
  );

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
          claimedPaths={claimedPaths}
          {...(searchQuery !== undefined ? { searchQuery } : {})}
          {...(onSearchChange !== undefined ? { onSearchChange } : {})}
          {...(raw !== undefined ? { raw } : {})}
          {...(deltas !== undefined ? { deltas } : {})}
          {...(customRenderers !== undefined ? { customRenderers } : {})}
        />
      ))}
    </div>
  );
}

function SectionView({
  section,
  definition,
  ctx,
  claimedPaths,
  searchQuery,
  onSearchChange,
  raw,
  deltas,
  customRenderers,
}: {
  section: SectionInstance;
  definition?: SectionDefinition<unknown>;
  ctx: DetailRenderContext;
  claimedPaths: ReadonlySet<string>;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  raw?: unknown;
  deltas?: Record<string, number>;
  customRenderers?: CustomSectionRegistry;
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
    case "breakdown":
      return (
        <BreakdownSection
          instance={section}
          {...(definition?.kind === "breakdown"
            ? { definition: definition as BreakdownSectionDefinition<unknown, unknown> }
            : {})}
          ctx={ctx}
          {...(deltas !== undefined ? { deltas } : {})}
        />
      );
    case "timeline":
      return (
        <TimelineSection
          instance={section}
          {...(definition?.kind === "timeline"
            ? { definition: definition as TimelineSectionDefinition<unknown, unknown> }
            : {})}
          ctx={ctx}
        />
      );
    case "ranking":
      return (
        <RankingSection
          instance={section}
          {...(definition?.kind === "ranking"
            ? { definition: definition as RankingSectionDefinition<unknown, unknown> }
            : {})}
          ctx={ctx}
        />
      );
    case "array":
      return <ArraySection instance={section} ctx={ctx} />;
    case "dynamicMap":
      return (
        <DynamicMapSection
          instance={section}
          ctx={ctx}
          hiddenNestedPaths={claimedPaths}
          {...(deltas !== undefined ? { deltas } : {})}
        />
      );
    case "unknownFields":
      return <UnknownFieldsSection instance={section} ctx={ctx} {...(raw !== undefined ? { raw } : {})} />;
    case "custom":
      return (
        <CustomSection
          instance={section}
          ctx={ctx}
          {...(customRenderers !== undefined ? { renderers: customRenderers } : {})}
        />
      );
  }
}
