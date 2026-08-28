// The DC Details page (spec §23.1), as a declarative definition.
//
// This is the first PRODUCTION page of the builder: /pulse/diag/dc renders
// it, and pulse/diag/dc.helpers.ts is now only the adapter that turns the
// `upstreams` topic (plus the separately gated per-DC network path) into
// the payload below. The old `dcGroups` flattened all twelve data centers
// into 255 KV rows at once; here the reader picks ONE and sees only its
// state, which is the whole point of §5.2.
//
// Two shapes are worth naming explicitly:
//
//   * DcPagePayload is the WHOLE snapshot — the entity selector reads its
//     `dcs` array;
//   * DcPageContext is one data center with the response-level metadata
//     folded in, because §23.1 puts `middle_proxy_enabled`, `reason` and
//     `generated_at_epoch_secs` on the page while the selected entity is a
//     bare `DcStatus`. Folding them into the context (rather than reading
//     them off the payload from inside a section) is what keeps the §27.4
//     completeness equation solvable: the resolver accounts for the context
//     it is given, so anything the page shows must BE in the context.

import type { DcStatus, DcStatusData, RuntimeMinimalDcPath } from "../../../realtime/topics";
import type { DetailPageDefinition, SummaryTone } from "../model";

export interface DcPagePayload extends DcStatusData {
  /**
   * Per-DC selected network path, from the separately gated `minimal`
   * runtime payload — merged in by the adapter, absent when that gate is
   * off. Never rendered from here: the context carries the matching entry.
   */
  network_paths?: RuntimeMinimalDcPath[];
}

export interface DcPageContext extends DcStatus {
  middle_proxy_enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  network_path?: RuntimeMinimalDcPath;
}

/** Stable semantic key (§5.3): the DC id, which survives any reordering. */
export function dcEntityKey(dc: Pick<DcStatus, "dc">): string {
  return `dc${dc.dc}`;
}

/**
 * §18.2's "domain-relevant states only", as the attention binding the DC
 * render draws on the selector: a data center with no live writer at all is
 * an outage, one below full coverage is a warning, everything else is
 * healthy and gets no marker.
 */
export function dcAttentionTone(dc: DcStatus): "warn" | "bad" | null {
  if (dc.alive_writers === 0) return "bad";
  if (dc.coverage_pct < 100 || dc.available_pct < 100) return "warn";
  return null;
}

function coverageTone(dc: DcPageContext): SummaryTone {
  if (dc.alive_writers === 0) return "bad";
  if (dc.coverage_pct < 100) return "warn";
  return "good";
}

function freshCoverageTone(dc: DcPageContext): SummaryTone {
  if (dc.fresh_alive_writers === 0) return "bad";
  if (dc.fresh_coverage_pct < 100) return "warn";
  return "good";
}

export const DC_PAGE_ID = "pulse.dc";

// dcPageDefinition — §23.1 literally: entity selector over the twelve DCs,
// five summary metrics, one scalar section of the fourteen routing fields,
// the two arrays as their OWN blocks (never a `N items` row, §10), the
// response metadata, and the extended-mode network path.
export const dcPageDefinition: DetailPageDefinition<DcPagePayload, DcPageContext> = {
  id: DC_PAGE_ID,
  title: (s) => s.details.pages.dc.title,
  description: (s) => s.details.pages.dc.description,

  sources: [
    { id: "upstreams", topic: "upstreams", required: true, freshnessPath: "generated_at_epoch_secs" },
    // The per-DC network path lives behind its own gate
    // (minimal_runtime_enabled). Optional on purpose: with the gate off the
    // page is `partial` and every other section keeps working, which is
    // §14's rule that a global error must not replace what still works.
    { id: "runtime", topic: "runtime", required: false },
  ],

  freshness: { atEpochMs: (p) => p.generated_at_epoch_secs * 1000 },

  navigation: {
    entities: {
      path: "dcs",
      entityKey: (item) => dcEntityKey(item as DcStatus),
      label: (item) => `DC ${(item as DcStatus).dc}`,
      attention: (item) => {
        const tone = dcAttentionTone(item as DcStatus);
        if (tone === null) return null;
        return {
          tone,
          reason: (s) =>
            tone === "bad" ? s.details.pages.dc.attention.uncovered : s.details.pages.dc.attention.degraded,
        };
      },
    },
    selectEntity: (payload, key) => selectDcContext(payload, key),
  },

  // No `label` on any tile: the catalog's short label names it, so
  // "Свежее покрытие" and "Fresh coverage" come from one place and the raw
  // key never reaches a tile (Task 3 review carry-over).
  summary: [
    { id: "load", value: (dc) => dc.load, format: "decimal" },
    { id: "coverage", path: "coverage_pct", value: (dc) => dc.coverage_pct, unit: "percent", tone: coverageTone },
    {
      id: "fresh_coverage",
      path: "fresh_coverage_pct",
      value: (dc) => dc.fresh_coverage_pct,
      unit: "percent",
      tone: freshCoverageTone,
    },
    { id: "rtt", path: "rtt_ms", value: (dc) => dc.rtt_ms, unit: "milliseconds" },
  ],

  sections: [
    {
      kind: "scalars",
      id: "routing",
      title: (s) => s.details.pages.dc.routing,
      sourceId: "upstreams",
      defaultExpanded: true,
      fields: [
        { path: "dc" },
        { path: "available_endpoints" },
        { path: "available_pct" },
        { path: "required_writers" },
        { path: "floor_min" },
        { path: "floor_target" },
        { path: "floor_max" },
        { path: "floor_capped" },
        { path: "alive_writers" },
        { path: "coverage_pct" },
        { path: "fresh_alive_writers" },
        { path: "fresh_coverage_pct" },
        { path: "rtt_ms" },
        { path: "load" },
      ],
    },
    // §23.1: both arrays are ArraySections. `endpoints[]` is a list of
    // primitives, `endpoint_writers[]` a list of two-field records — the
    // renderer tells them apart on its own (§10.1 vs §10.2), and neither
    // is ever comma-joined or reduced to "N items".
    //
    // The titles stay Telemt's own field names: §8.1/§11.2 make a key data,
    // shown verbatim, so what gets translated is the sentence under it.
    {
      kind: "array",
      id: "endpoints",
      title: () => "endpoints[]",
      description: (s) => s.details.pages.dc.endpoints,
      sourceId: "upstreams",
      path: "endpoints",
      defaultExpanded: true,
    },
    {
      kind: "array",
      id: "endpoint_writers",
      title: () => "endpoint_writers[]",
      description: (s) => s.details.pages.dc.endpointWriters,
      sourceId: "upstreams",
      path: "endpoint_writers",
      itemKey: (item, i) => `${(item as { endpoint?: string }).endpoint ?? ""}-${i}`,
    },
    {
      kind: "scalars",
      id: "metadata",
      title: (s) => s.details.pages.dc.metadata,
      sourceId: "upstreams",
      fields: [
        { path: "middle_proxy_enabled" },
        { path: "reason" },
        { path: "generated_at_epoch_secs" },
      ],
    },
    // The network path is the extended-mode block the old page merged into
    // each DC group under a `network_path.` prefix — same data, same
    // catalog entries, now behind its own source and its own mode filter.
    {
      kind: "scalars",
      id: "network_path",
      title: (s) => s.details.pages.dc.networkPath,
      sourceId: "runtime",
      minMode: "extended",
      fields: [
        { path: "network_path.dc" },
        { path: "network_path.ip_preference" },
        { path: "network_path.selected_addr_v4" },
        { path: "network_path.selected_addr_v6" },
      ],
    },
  ],

  unknownFields: { minMode: "extended", rawJson: true },
};

// selectDcContext narrows the payload to ONE data center and folds in the
// response metadata plus that DC's network path. Exported so the adapter
// tests and the page can build a context without a React tree.
export function selectDcContext(
  payload: DcPagePayload,
  key: string | undefined,
): DcPageContext | null {
  const dc = payload.dcs.find((candidate) => dcEntityKey(candidate) === key) ?? payload.dcs[0];
  if (dc === undefined) return null;
  const path = (payload.network_paths ?? []).find((entry) => entry.dc === dc.dc);
  return {
    ...dc,
    middle_proxy_enabled: payload.middle_proxy_enabled,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    generated_at_epoch_secs: payload.generated_at_epoch_secs,
    ...(path !== undefined ? { network_path: path } : {}),
  };
}
