import { createElement } from "react";
import { useStrings } from "../../../i18n";
import type { ClassifyContext, CustomSectionInstance } from "../resolveSections";
import { SectionFrame } from "./SectionFrame";
import { NodeList } from "./NodeTree";
import { buildValueNodes } from "./unknownFields";
import { lookupCustomRenderer, type CustomSectionRegistry } from "./customRenderers";
import { isSectionExpanded, type DetailRenderContext } from "./context";

export interface CustomSectionProps {
  instance: CustomSectionInstance;
  ctx: DetailRenderContext;
  /** Renderer table; the builder's own reference registry when omitted. */
  renderers?: CustomSectionRegistry;
}

// CustomSection is §9.8: the escape hatch, with the shared contracts kept
// OUTSIDE the escape. The accordion, the title, the description and the
// display-mode filter are this component's; only the drawing of the data is
// the registered renderer's.
//
// An unregistered id falls back to the generic node tree. That is not a
// nicety: a custom section CONSUMES paths as far as the completeness
// equation is concerned (§27.4), so a renderer that failed to resolve must
// still put those fields on screen, or the guarantee would be a lie.
export function CustomSection({ instance, ctx, renderers }: CustomSectionProps) {
  const s = useStrings();
  const Renderer = lookupCustomRenderer(renderers, instance.renderer);
  const classifyCtx: ClassifyContext = {
    ...(ctx.lookup.catalog !== undefined ? { catalog: ctx.lookup.catalog } : {}),
    ...(ctx.lookup.endpoint !== undefined ? { endpoint: ctx.lookup.endpoint } : {}),
  };

  return (
    <SectionFrame
      id={instance.id}
      title={instance.title(s)}
      description={instance.description?.(s)}
      expanded={isSectionExpanded(instance.id, instance.defaultExpanded, ctx.expandedSections)}
      onToggle={() => ctx.toggleSection(instance.id)}
    >
      {Renderer === null
        ? <NodeList nodes={buildValueNodes(instance.value, instance.path, classifyCtx)} ctx={ctx} />
        : // createElement rather than <Renderer/>: the component is looked
          // up by id at render time, which is the whole point of a registry.
          // It is stable for the life of the section (the id comes from the
          // definition), so nothing here recreates a component per frame.
          createElement(Renderer, { instance, ctx })}
    </SectionFrame>
  );
}
