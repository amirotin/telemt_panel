// The NAT / STUN Details page (spec §23.5), as a declarative definition.
//
// What it replaces: `natGroups` + `flattenToRows` turned `servers` into two
// comma-free but structureless runs of `servers.configured.0 … .12` KV rows
// and made an absent `reflection.v4` disappear entirely. §23.5 asks for
// «primitive/record ArraySection для configured/live servers», and
// TELEMT_LIVE_API_DATA §15 explains why the second one matters: the three
// live VPS carried 13 configured servers each and 10 / 7 / 0 live ones, so
// the leaf schema legitimately DIFFERS between healthy proxies.
//
// The two states that page must never blur together:
//
//   * `servers.live` empty — the last responder snapshot is empty. Telemt
//     can clear this list while retaining a usable reflection cache, so the
//     block stays visible but is not health on its own;
//   * `reflection.v4` / `.v6` absent — that family has no reflection yet.
//     Both halves are declared as rows, so an absent one reads «не пришло
//     в ответе» instead of leaving a blank where a value belongs (§13.1).

import type { RuntimeNatStun } from "../../../realtime/topics";
import type { DetailPageDefinition, SummaryTone } from "../model";

export const NAT_PAGE_ID = "pulse.nat";

// pool_nat.rs keeps reflected addresses for ten minutes. The API exposes the
// cache age but not its TTL, so the UI mirrors that runtime invariant here.
export const STUN_REFLECTION_TTL_SECONDS = 600;

function probeFailureSignal(nat: RuntimeNatStun): boolean {
  if (!nat.flags?.nat_probe_enabled || nat.flags?.nat_probe_disabled_runtime) return false;
  return (nat.flags?.nat_probe_attempts ?? 0) > 0 || (nat.stun_backoff_remaining_ms ?? 0) > 0;
}

export function probeFailureConfirmed(nat: RuntimeNatStun): boolean {
  return reflectionAgeSecs(nat) === null && probeFailureSignal(nat);
}

export function liveTone(nat: RuntimeNatStun): SummaryTone {
  const configured = nat.servers?.configured?.length ?? 0;
  const live = nat.servers?.live_total ?? 0;
  if (live === 0) return configured > 0 && probeFailureConfirmed(nat) ? "bad" : "neutral";
  return "good";
}

/**
 * The freshest reflection age across the two families, in seconds. Null when
 * neither family has reflected yet — which is a state of its own and shows
 * «—», not a confident 0 (§13.1).
 */
export function reflectionAgeSecs(nat: RuntimeNatStun | null | undefined): number | null {
  const ages = [nat?.reflection?.v4?.age_secs, nat?.reflection?.v6?.age_secs].filter(
    (age): age is number => typeof age === "number",
  );
  return ages.length === 0 ? null : Math.min(...ages);
}

export function reflectionTone(nat: RuntimeNatStun): SummaryTone {
  if (!nat.flags?.nat_probe_enabled || nat.flags?.nat_probe_disabled_runtime) return "neutral";
  const age = reflectionAgeSecs(nat);
  if (age !== null && age < STUN_REFLECTION_TTL_SECONDS) return "good";
  if (age !== null) return probeFailureSignal(nat) ? "warn" : "neutral";
  return probeFailureSignal(nat) ? "bad" : "neutral";
}

export const natPageDefinition: DetailPageDefinition<RuntimeNatStun, RuntimeNatStun> = {
  id: NAT_PAGE_ID,
  title: (s) => s.details.pages.nat.title,
  description: (s) => s.details.pages.nat.description,

  sources: [{ id: "nat", topic: "runtime", required: true }],

  summary: [
    {
      id: "live_total",
      path: "servers.live_total",
      value: (p) => p.servers?.live_total ?? null,
      format: "integer",
      tone: liveTone,
    },
    {
      id: "configured",
      path: "servers.configured",
      label: (s) => s.details.pages.nat.configuredTile,
      value: (p) => p.servers?.configured?.length ?? null,
      format: "integer",
    },
    {
      id: "attempts",
      path: "flags.nat_probe_attempts",
      value: (p) => p.flags?.nat_probe_attempts ?? null,
      format: "integer",
    },
    {
      id: "reflection_age",
      label: (s) => s.details.pages.nat.reflectionAgeTile,
      value: (p) => reflectionAgeSecs(p),
      unit: "seconds",
      tone: reflectionTone,
    },
  ],

  sections: [
    {
      kind: "scalars",
      id: "flags",
      title: (s) => s.details.pages.nat.flags,
      sourceId: "nat",
      defaultExpanded: true,
      fields: [
        { path: "flags.nat_probe_enabled" },
        { path: "flags.nat_probe_disabled_runtime" },
        { path: "flags.nat_probe_attempts" },
        { path: "stun_backoff_remaining_ms" },
      ],
    },
    // Both reflection families are DECLARED, present or not: §13.1 needs an
    // absent value to be visible as an absence, and a page that simply drops
    // the v6 rows tells a reader nothing about whether v6 was even tried.
    {
      kind: "scalars",
      id: "reflection",
      title: (s) => s.details.pages.nat.reflection,
      description: (s) => s.details.pages.nat.reflectionDescription,
      sourceId: "nat",
      defaultExpanded: true,
      fields: [
        { path: "reflection.v4.addr" },
        { path: "reflection.v4.age_secs" },
        { path: "reflection.v6.addr" },
        { path: "reflection.v6.age_secs" },
      ],
      // With NEITHER family reflected, `reflection` arrives as `{}` — an
      // empty object is a leaf of its own (§10.3) and belongs to the block
      // that speaks for it, not to the unknown tail.
      alsoConsumes: ["reflection"],
    },
    {
      kind: "scalars",
      id: "servers",
      title: (s) => s.details.pages.nat.servers,
      sourceId: "nat",
      defaultExpanded: true,
      fields: [{ path: "servers.live_total" }],
    },
    // §10.1: a list of addresses is a LIST — one row per server, never
    // comma-joined and never «13 items».
    {
      kind: "array",
      id: "configured",
      title: () => "servers.configured[]",
      description: (s) => s.details.pages.nat.configuredDescription,
      sourceId: "nat",
      path: "servers.configured",
    },
    {
      kind: "array",
      id: "live",
      title: () => "servers.live[]",
      description: (s) => s.details.pages.nat.liveDescription,
      sourceId: "nat",
      path: "servers.live",
      // Empty on one of the three live VPS. Expanded on purpose: «ни один
      // сервер не ответил» is the answer a reader came for, and hiding it
      // behind a closed accordion is the same as not saying it.
      defaultExpanded: true,
    },
  ],

  unknownFields: { minMode: "extended", rawJson: true },
};
