// Edge-case fixtures — the states a renderer gets wrong when it is only
// ever tested against a healthy production snapshot (spec §27.2):
//
//   * every optional array in four variants: absent / empty / one / many
//     (absent and empty are DIFFERENT — "нет данных" vs "источник ответил
//     пустым списком", TELEMT_LIVE_API_DATA.md §3);
//   * scalars at their falsy edges: null, false, 0 — none of which may
//     render as an em dash or disappear;
//   * identifiers far longer than anything in the snapshot, because a
//     phone in portrait is where a long endpoint or JA3 raw string breaks
//     the layout.
//
// A factory, not four hand-written copies of every fixture: the variants
// are generated from the production-size fixtures this directory already
// exports, so a change there cannot leave the edge cases behind.
import type {
  DcStatus,
  Gated,
  MeWriterStatus,
  RuntimeMeSelftest,
  RuntimeNatStun,
} from "../../../realtime/topics";
import type { TlsFingerprintRow } from "../../../lib/api/generated/types.gen";
import { dcs, meWriters } from "./stats";
import { natStunLive0, natStunLive10 } from "./runtime";
import { tlsFingerprints } from "./security";

/** The four states any optional array can arrive in. */
export type ArrayVariant = "absent" | "empty" | "one" | "many";

export const arrayVariants: readonly ArrayVariant[] = ["absent", "empty", "one", "many"] as const;

// arrayVariant projects a full list onto one variant. `absent` is
// `undefined` — the caller deletes the key rather than assigning it, which
// is the only way to reproduce Go's omitempty on the wire.
export function arrayVariant<T>(items: readonly T[], variant: ArrayVariant): T[] | undefined {
  switch (variant) {
    case "absent":
      return undefined;
    case "empty":
      return [];
    case "one":
      return items.slice(0, 1);
    case "many":
      return [...items];
  }
}

// withArrayVariant returns a copy of `base` with one array-valued key set
// to the requested variant, deleting the key outright for `absent`.
export function withArrayVariant<T extends object, K extends keyof T>(
  base: T,
  key: K,
  variant: ArrayVariant,
  items: readonly unknown[],
): T {
  const next = { ...base } as Record<PropertyKey, unknown>;
  const value = arrayVariant(items, variant);
  if (value === undefined) {
    // Deleting rather than assigning undefined: only a missing key
    // reproduces Go's omitempty, and `"key" in payload` is how a renderer
    // tells "absent" from "empty".
    delete next[key as PropertyKey];
  } else {
    next[key as PropertyKey] = value;
  }
  return next as T;
}

// allArrayVariants builds the whole four-way matrix for one key in one
// call — how a test enumerates the cases instead of naming them.
export function allArrayVariants<T extends object, K extends keyof T>(
  base: T,
  key: K,
  items: readonly unknown[],
): Record<ArrayVariant, T> {
  return {
    absent: withArrayVariant(base, key, "absent", items),
    empty: withArrayVariant(base, key, "empty", items),
    one: withArrayVariant(base, key, "one", items),
    many: withArrayVariant(base, key, "many", items),
  };
}

// gatedOff is the other half of Gated[T]: the source is switched off, so
// `data` never arrives and `reason` says why.
export function gatedOff<T>(reason = "feature_disabled"): Gated<T> {
  return { enabled: false, reason, generated_at_epoch_secs: 1756000000 };
}

// gatedUnavailable: the feature is on but this poll had no data — enabled
// true with no payload, which must NOT render as "empty results".
export function gatedUnavailable<T>(): Gated<T> {
  return { enabled: true, reason: "source_unavailable", generated_at_epoch_secs: 1756000000, data: null };
}

// --- optional-array matrices over the real fixtures ---------------------

/** `endpoints[]` on a DC — 1..10 in production, all four variants here. */
export const dcEndpointVariants = allArrayVariants(dcs.dcs[0], "endpoints", dcs.dcs[11].endpoints);

/** `endpoint_writers[]` on a DC. */
export const dcEndpointWriterVariants = allArrayVariants(
  dcs.dcs[0],
  "endpoint_writers",
  dcs.dcs[0].endpoint_writers,
);

/** `writers[]` on the ME writers payload — empty pool vs 46. */
export const meWriterVariants = allArrayVariants(meWriters, "writers", meWriters.writers);

/** `by_fingerprint[]` on the TLS payload — 0, 1 and 50 records. */
export const tlsByFingerprintVariants = allArrayVariants(
  tlsFingerprints,
  "by_fingerprint",
  tlsFingerprints.by_fingerprint,
);

/** `live[]` STUN servers — the 0-live production case is the `empty` one. */
export const stunLiveVariants = allArrayVariants(
  natStunLive10.servers,
  "live",
  natStunLive10.servers.live,
);

// --- scalar edges -------------------------------------------------------

// dcAllFalsy — a DC whose every nullable/boolean/numeric field sits at its
// falsy edge: rtt_ms null (never measured), floor_capped false, and load /
// coverage / writer counts all 0. A DC that is genuinely down looks like
// this, and none of these values may be dropped as "no data".
export const dcAllFalsy: DcStatus = {
  ...dcs.dcs[0],
  dc: 0,
  available_endpoints: 0,
  available_pct: 0,
  required_writers: 0,
  floor_min: 0,
  floor_target: 0,
  floor_max: 0,
  floor_capped: false,
  alive_writers: 0,
  coverage_pct: 0,
  fresh_alive_writers: 0,
  fresh_coverage_pct: 0,
  rtt_ms: null,
  load: 0,
};

// writerAllNull — every nullable field on a writer at null at once: no DC
// assigned yet, no RTT sample, no idle measurement, no drain timestamps.
export const writerAllNull: MeWriterStatus = {
  ...meWriters.writers[0],
  dc: null,
  rtt_ema_ms: null,
  idle_for_secs: null,
  drain_started_at_epoch_secs: null,
  drain_deadline_epoch_secs: null,
  bound_clients: 0,
  degraded: false,
  draining: false,
  allow_drain_fallback: false,
  drain_over_ttl: false,
  in_desired_map: false,
  matches_active_generation: false,
};

// selftestAllNullable — both IP families absent AND `bnd` null, the widest
// nullable spread §16 allows (the live snapshot only ever showed part of
// it, which is why schema equality between VPS was false).
export const selftestAllNullable: RuntimeMeSelftest = {
  kdf: { state: "unknown", ewma_errors_per_min: 0, threshold_errors_per_min: 0, errors_total: 0 },
  timeskew: { state: "unknown", max_skew_secs_15m: null, samples_15m: 0 },
  ip: {},
  pid: { pid: 0, state: "unknown" },
  bnd: null,
};

/** NAT/STUN with nothing live and no reflection at all (the node-c case). */
export const natStunNoReflection: RuntimeNatStun = natStunLive0;

// --- very long identifiers ---------------------------------------------

// A 145-character endpoint: an IPv6 literal with a long path-ish suffix.
// Nothing this long appeared in production; the point is that the layout
// must survive it without horizontal overflow (spec §27.2).
export const longEndpoint =
  "[2001:0db8:0000:0000:0000:0000:0000:0007]:8443/very-long-endpoint-label-that-a-narrow-phone-viewport-cannot-fit-on-one-line-and-must-wrap-instead";

// A JA3 raw string at the long end of what a real client hello produces.
export const longFingerprintRaw =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53," +
  "0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24-25-256-257,0";

// A counter key far past anything zero/all currently emits — the generic
// fallback renderer has to describe keys it has never seen (§8.2 step 5).
export const longCounterKey =
  "middle_proxy_adaptive_floor_recover_after_single_endpoint_outage_with_quarantine_disabled_attempts_total";

// A description long enough to force the two-column DescribedRow into its
// wrapped form on a 360 px viewport.
export const longDescription =
  "Количество попыток восстановления пула писателей после отключения единственного эндпоинта, " +
  "когда карантин эндпоинтов выключен настройкой и адаптивный пол вынужден пересчитывать цель " +
  "по числу ядер, а не по числу живых эндпоинтов.";

// tlsRowLongIdentifiers — one TLS record where every identifier is at its
// long edge at once, for the RankingSection's row and detail surface.
export const tlsRowLongIdentifiers: TlsFingerprintRow = {
  ...tlsFingerprints.by_ip[0],
  scope: longEndpoint,
  ja3_raw: longFingerprintRaw,
  ja4_raw: `${longFingerprintRaw}_${longFingerprintRaw}`,
};
