// TEMPORARY, TEST-ONLY page definitions.
//
// The real ones land with the domain migrations (Tasks 6–8). These exist so
// checkpoint R1 (ruling R7, spec §27.4) can run from Task 2 onwards: the
// completeness equation
//
//     all leaves − consumed − explicitly ignored − unknown tail = ∅
//
// needs A definition per fixture, and a definition with no sections is a
// perfectly valid one — everything lands in the unknown tail, which is
// exactly the "nothing is silently dropped" guarantee the checkpoint is
// about. Several fixtures get a real definition anyway, so the consumed
// side of the equation is exercised rather than trivially empty, and each
// of the eight section kinds is instantiated at least once.
//
// Nothing here is imported by application code.
import type { DcStatus, MeWritersData } from "../../../realtime/topics";
import type { DetailPageDefinition } from "../model";
import { dcs, initialization, meWriters, minimalAll, summary, tlsFingerprints, zeroAll } from ".";

export type AnyDefinition = DetailPageDefinition<unknown, unknown>;

const source = (id: string, required = true) => ({ id, required });

// --- DC: the worked example, using six of the eight section kinds -------

export const dcPageDefinition: DetailPageDefinition<typeof dcs, DcStatus> = {
  id: "dev.dc",
  title: (s) => s.diag.domains.dc,
  sources: [{ ...source("upstreams"), topic: "upstreams" }],
  sections: [
    {
      kind: "scalars",
      id: "identity",
      title: (s) => s.diag.groups.summary,
      fields: [
        { path: "dc" },
        { path: "available_endpoints" },
        { path: "available_pct" },
        { path: "required_writers" },
        { path: "alive_writers" },
        { path: "coverage_pct" },
        { path: "fresh_alive_writers" },
        { path: "fresh_coverage_pct" },
        { path: "rtt_ms" },
        { path: "load" },
        // Deliberately bound as a scalar though it is an array: §9.1 says
        // the resolver extracts it instead of rendering "10 items".
        { path: "endpoints" },
      ],
    },
    {
      kind: "scalars",
      id: "floor",
      title: (s) => s.diag.groups.flags,
      fields: [
        { path: "floor_min" },
        { path: "floor_target" },
        { path: "floor_max" },
        { path: "floor_capped" },
      ],
    },
    {
      kind: "array",
      id: "endpoints",
      title: (s) => s.diag.groups.dcs,
      path: "endpoints",
    },
    {
      kind: "entityList",
      id: "endpoint-writers",
      title: (s) => s.diag.groups.writers,
      path: "endpoint_writers",
      itemKey: (item, index) => String((item as { endpoint?: string }).endpoint ?? index),
      identity: (item) => String((item as { endpoint?: string }).endpoint ?? ""),
    },
  ],
};

// --- ME writers: entityList over the 46-writer production pool ---------

export const meWritersPageDefinition: DetailPageDefinition<MeWritersData, MeWritersData> = {
  id: "dev.me-writers",
  title: (s) => s.diag.groups.meWriters,
  sources: [{ ...source("upstreams"), topic: "upstreams" }],
  sections: [
    {
      kind: "entityList",
      id: "writers",
      title: (s) => s.diag.groups.writers,
      path: "writers",
      itemKey: (item, index) => String((item as { id?: unknown }).id ?? index),
      identity: (item) => String((item as { id?: unknown }).id ?? ""),
      highlights: ["rtt_ema_ms", "bound_clients"],
    },
  ],
};

// --- Counters: dynamicMap with the five zero/all groups ----------------

export const countersPageDefinition: DetailPageDefinition<typeof zeroAll, typeof zeroAll> = {
  id: "dev.counters",
  title: (s) => s.diag.domains.counters,
  sources: [{ ...source("zero"), endpoint: "/api/telemt/zero" }],
  sections: [
    {
      kind: "dynamicMap",
      id: "counters",
      title: (s) => s.diag.groups.zeroCounters,
      path: "",
      supportsDelta: true,
      groups: [
        { id: "core", title: (s) => s.diag.groups.core, path: "core" },
        { id: "upstream", title: (s) => s.diag.groups.upstream, path: "upstream" },
        { id: "middle_proxy", title: (s) => s.diag.groups.middleProxy, path: "middle_proxy" },
        { id: "pool", title: (s) => s.diag.groups.pool, path: "pool" },
        { id: "desync", title: (s) => s.diag.groups.desync, path: "desync" },
      ],
      alsoConsumes: ["generated_at_epoch_secs"],
    },
  ],
};

// --- Initialization: the timeline kind ----------------------------------

export const initializationPageDefinition: DetailPageDefinition<
  typeof initialization,
  typeof initialization
> = {
  id: "dev.initialization",
  title: (s) => s.diag.groups.initialization,
  sources: [{ ...source("runtime"), topic: "runtime" }],
  sections: [
    {
      kind: "timeline",
      id: "components",
      title: (s) => s.diag.groups.initialization,
      path: "components",
      status: (item) => String((item as { status?: unknown }).status ?? ""),
      step: (item) => String((item as { name?: unknown }).name ?? ""),
      durationMs: (item) => (item as { duration_ms?: number }).duration_ms ?? null,
    },
  ],
};

// --- TLS: the ranking kind over 4×50 records ---------------------------

export const tlsPageDefinition: DetailPageDefinition<typeof tlsFingerprints, typeof tlsFingerprints> =
  {
    id: "dev.tls",
    title: (s) => s.diag.groups.tlsByFingerprint,
    sources: [{ ...source("tls"), endpoint: "/api/telemt/tls-fingerprints" }],
    sections: [
      {
        kind: "ranking",
        id: "by-fingerprint",
        title: (s) => s.diag.groups.tlsByFingerprint,
        path: "by_fingerprint",
        itemKey: (item, index) => String((item as { ja3?: unknown }).ja3 ?? index),
        identity: (item) => String((item as { ja3?: unknown }).ja3 ?? ""),
        score: (item) => Number((item as { total?: unknown }).total ?? 0),
      },
      {
        kind: "ranking",
        id: "by-ip",
        title: (s) => s.diag.groups.tlsByIp,
        path: "by_ip",
        itemKey: (item, index) => String((item as { scope?: unknown }).scope ?? index),
        identity: (item) => String((item as { scope?: unknown }).scope ?? ""),
        score: (item) => Number((item as { total?: unknown }).total ?? 0),
      },
    ],
  };

// --- Summary: the breakdown kind plus an explicit ignore policy --------

export const summaryPageDefinition: DetailPageDefinition<typeof summary, typeof summary> = {
  id: "dev.summary",
  title: (s) => s.diag.groups.summary,
  sources: [{ ...source("stats"), topic: "stats" }],
  sections: [
    {
      kind: "breakdown",
      id: "connections-bad",
      title: (s) => s.diag.groups.totals,
      path: "connections_bad_by_class",
      label: (item) => String((item as { class?: unknown }).class ?? ""),
      total: (item) => Number((item as { total?: unknown }).total ?? 0),
    },
    {
      kind: "breakdown",
      id: "handshake-failures",
      title: (s) => s.diag.groups.telemetry,
      path: "handshake_failures_by_class",
      label: (item) => String((item as { class?: unknown }).class ?? ""),
      total: (item) => Number((item as { total?: unknown }).total ?? 0),
    },
  ],
  unknownFields: {
    ignore: [
      // §24.2's second outcome: dropped ON PURPOSE, with a reason a reader
      // of the definition can audit — not silently.
      { path: "uptime_seconds", reason: "shown by the page header, not as a row" },
    ],
  },
};

// --- Minimal: the custom kind -------------------------------------------

export const minimalPageDefinition: DetailPageDefinition<typeof minimalAll, typeof minimalAll> = {
  id: "dev.minimal",
  title: (s) => s.diag.groups.meRuntimeTuning,
  sources: [{ ...source("runtime"), topic: "runtime" }],
  sections: [
    {
      kind: "custom",
      id: "network-path",
      title: (s) => s.diag.groups.networkPath,
      renderer: "network-path",
      consumes: ["network_path"],
    },
  ],
};

// --- the empty definition -----------------------------------------------

// emptyDefinition covers every remaining fixture: no configured section, so
// the whole payload lands in the unknown tail. That is the honest state of
// a domain nobody has migrated yet, and the completeness equation must hold
// for it exactly as it does for a fully described page.
export function emptyDefinition(id: string): AnyDefinition {
  return {
    id,
    title: (s) => s.details.unknown.title,
    sources: [source(id)],
    sections: [],
  };
}

export const richDefinitions = {
  dc: dcPageDefinition as unknown as AnyDefinition,
  meWriters: meWritersPageDefinition as unknown as AnyDefinition,
  counters: countersPageDefinition as unknown as AnyDefinition,
  initialization: initializationPageDefinition as unknown as AnyDefinition,
  tls: tlsPageDefinition as unknown as AnyDefinition,
  summary: summaryPageDefinition as unknown as AnyDefinition,
  minimal: minimalPageDefinition as unknown as AnyDefinition,
};

export const richContexts: Record<keyof typeof richDefinitions, unknown> = {
  dc: dcs.dcs[0],
  meWriters,
  counters: zeroAll,
  initialization,
  tls: tlsFingerprints,
  summary,
  minimal: minimalAll,
};
