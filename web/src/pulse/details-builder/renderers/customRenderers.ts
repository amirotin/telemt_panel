// The custom-renderer contract (spec §9.8).
//
// A CustomSection names its renderer by STRING id, and the page resolves
// that id through a registry. The indirection is what keeps the builder
// domain-free: `details-builder/` never imports a chart, and a domain
// module never has to reach inside the builder to render one.
//
// Three rules a registered renderer inherits and cannot opt out of:
//
//   * the accordion, the title, the count badge and the loading / error /
//     empty / absent states belong to CustomSection, not to the renderer —
//     a chart draws the DATA and nothing else;
//   * an id nobody registered is not an error. The section falls back to
//     the generic node tree, so a page shipped before its chart still shows
//     every field it consumes, and the completeness equation (§27.4) keeps
//     holding;
//   * the renderer is a plain function of `{ instance, ctx }`, so a test
//     can call it with a resolved instance and no page around it.

import type { ComponentType } from "react";
import type { CustomSectionInstance } from "../resolveSections";
import { QualityChart } from "./QualityChart";
import type { DetailRenderContext } from "./context";

export interface CustomSectionRendererProps {
  instance: CustomSectionInstance;
  ctx: DetailRenderContext;
}

// A COMPONENT type, not a bare function: a renderer is rendered as JSX so
// its own hooks (useStrings, useState) belong to it rather than to the
// section that hosts it.
export type CustomSectionRenderer = ComponentType<CustomSectionRendererProps>;

export type CustomSectionRegistry = Readonly<Record<string, CustomSectionRenderer>>;

/** The id the reference quality chart is registered under. */
export const QUALITY_CHART_RENDERER = "quality-chart";

// DEFAULT_CUSTOM_RENDERERS ships exactly one renderer — the reference
// implementation. Domain charts join it from their own definition modules
// (Tasks 7–8) by passing an extended registry to DetailPage.
export const DEFAULT_CUSTOM_RENDERERS: CustomSectionRegistry = {
  [QUALITY_CHART_RENDERER]: QualityChart,
};

export function lookupCustomRenderer(
  registry: CustomSectionRegistry | undefined,
  id: string,
): CustomSectionRenderer | null {
  const table = registry ?? DEFAULT_CUSTOM_RENDERERS;
  return Object.hasOwn(table, id) ? (table[id] as CustomSectionRenderer) : null;
}
