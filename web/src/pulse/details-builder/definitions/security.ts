// The Security / TLS Details page (spec §23.3), as a declarative definition.
//
// What it replaces: `securityGroups` + `flattenToRows` turned the four TLS
// rankings into ~2 000 flat KV rows on one screen. §23.3 makes each of them
// a RankingSection of its own — 20 rows visible, search, sort, and every
// remaining JA3/JA4 field in the adaptive surface — and the four never mix.
//
// TWO sources, deliberately independent (M4 task 1): posture/whitelist/
// effective limits arrive on the `security` SSE topic, while the TLS
// aggregates are ~120 KB and are fetched on visit through
// GET /api/telemt/tls-fingerprints. The TLS source is NOT required, so all
// of ruling R5's states — `disabled` (runtime_edge off, the admin has a
// switch), `unsupported` (the build predates the route), `error`, `stale` —
// leave the posture tab fully readable and merely mark the page `partial`.
//
// The context is FLAT on the TLS half on purpose. The catalog's TLS entries
// are endpoint-scoped (ruling R9) and keyed `by_fingerprint.*.ja3`,
// `limit`, `capacity` — the very spellings the REST payload uses. Nesting
// it under a `tls.` prefix would orphan every one of those descriptions for
// the sake of a tidier type.

import { fill } from "../../../i18n";
import type {
  EffectiveLimits,
  SecurityPosture,
  SecurityWhitelist,
} from "../../../realtime/topics";
import type { TlsFingerprintRow, TlsFingerprints } from "../../../lib/api/generated/types.gen";
import type { DetailPageDefinition, RankingSectionDefinition, SummaryTone } from "../model";

export interface SecurityPageData extends Partial<TlsFingerprints> {
  posture?: SecurityPosture;
  whitelist?: SecurityWhitelist;
  effective_limits?: EffectiveLimits;
}

export const SECURITY_PAGE_ID = "pulse.security";

const rowOf = (item: unknown) => item as TlsFingerprintRow;

/** The four scopes §19 documents, in the order §23.3 lists them. */
export const TLS_SCOPE_PATHS = ["by_fingerprint", "by_ip", "by_cidr", "by_user"] as const;
export type TlsScopePath = (typeof TLS_SCOPE_PATHS)[number];

// scopeCount is a ranking tab's badge: the number of records the scope
// holds, or null when the TLS source has not answered (absent key), which is
// a different thing from an empty ranking.
function scopeCount(payload: SecurityPageData, path: TlsScopePath): number | null {
  const rows = payload[path];
  return rows === undefined ? null : rows.length;
}

// tlsRanking builds one of §23.3's four tabs. They differ in exactly two
// ways — which array they read and what names a row — so the shape is
// written once and the differences are arguments.
//
// R6 (sensitive data): a scope IS an IP, a subnet or a panel username, and
// it is shown to the admin as-is — it is their own data, and the existing
// masking policy covers secrets, not identifiers. No copy menu is attached,
// here or anywhere on this page.
function tlsRanking(
  path: TlsScopePath,
  identity: (row: TlsFingerprintRow) => string,
): RankingSectionDefinition<SecurityPageData, unknown> {
  return {
    kind: "ranking",
    id: path,
    // Telemt's own field name for the collection: §11.2 makes a key data,
    // shown verbatim; the sentence beneath it is what gets translated.
    title: () => `${path}[]`,
    description: (s) => s.details.pages.security.rankingDescription,
    sourceId: "tls",
    path,
    defaultExpanded: true,
    // The honest semantic key, duplicates and all: `by_user` and `by_cidr`
    // really do name several records with one scope, and `uniqueEntryKeys`
    // disambiguates them from the record itself rather than from its
    // position, so a Telemt re-sort does not re-key every moved row.
    itemKey: (item) => identity(rowOf(item)),
    identity: (item) => identity(rowOf(item)),
    score: (item) => rowOf(item).total,
    scoreKey: "total",
    // The COUNT is Telemt's, the word in front of it is ours — so it comes
    // from the dictionaries like every other sentence on the page, not from
    // a template literal here (§11.2 makes the KEY verbatim, not the label).
    meta: (item, s) =>
      fill(s.details.pages.security.rankingMeta, { count: rowOf(item).bad_or_probe }),
    search: {
      terms: (item) => {
        const row = rowOf(item);
        return [row.ja3, row.ja3_raw, row.ja4, row.ja4_raw, row.scope ?? ""];
      },
    },
    // §23.3: "sort по `total` или `bad_or_probe`". `total` is already the
    // default order through `scoreKey`, so the explicit options are the
    // other two numeric columns a reader actually ranks by.
    sort: [
      {
        key: "bad_or_probe",
        label: () => "bad_or_probe",
        compare: (a, b) => rowOf(b).bad_or_probe - rowOf(a).bad_or_probe,
      },
      {
        key: "last_seen_epoch_secs",
        label: () => "last_seen_epoch_secs",
        compare: (a, b) => rowOf(b).last_seen_epoch_secs - rowOf(a).last_seen_epoch_secs,
      },
    ],
  };
}

function sumOf(
  rows: TlsFingerprintRow[] | undefined,
  pick: (row: TlsFingerprintRow) => number,
): number | null {
  if (rows === undefined) return null;
  return rows.reduce((sum, row) => sum + pick(row), 0);
}

function uniqueKeys(data: SecurityPageData): number | null {
  const lengths = TLS_SCOPE_PATHS.map((scope) => data[scope]?.length);
  if (lengths.every((n) => n === undefined)) return null;
  return lengths.reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

// A page whose TLS half is switched off shows «—» rather than a confident
// zero: §13.1 separates "no observations" from "no source".
function badTone(data: SecurityPageData): SummaryTone {
  const bad = sumOf(data.by_fingerprint, (row) => row.bad_or_probe);
  if (bad === null) return "neutral";
  return bad > 0 ? "warn" : "good";
}

export const securityPageDefinition: DetailPageDefinition<SecurityPageData, SecurityPageData> = {
  id: SECURITY_PAGE_ID,
  title: (s) => s.details.pages.security.title,
  description: (s) => s.details.pages.security.description,

  sources: [
    { id: "security", topic: "security", required: true },
    {
      id: "tls",
      endpoint: "/api/telemt/tls-fingerprints",
      required: false,
    },
  ],

  freshness: {
    atEpochMs: (p) =>
      p.whitelist?.generated_at_epoch_secs ? p.whitelist.generated_at_epoch_secs * 1000 : null,
  },

  summary: [
    {
      id: "observed",
      label: (s) => s.details.pages.security.observed,
      value: (p) => sumOf(p.by_fingerprint, (row) => row.total),
      format: "integer",
    },
    {
      id: "bad_or_probe",
      label: (s) => s.details.pages.security.badOrProbe,
      value: (p) => sumOf(p.by_fingerprint, (row) => row.bad_or_probe),
      format: "integer",
      tone: badTone,
    },
    {
      id: "unique_keys",
      label: (s) => s.details.pages.security.uniqueKeys,
      value: uniqueKeys,
      format: "integer",
    },
    {
      id: "whitelist_size",
      label: (s) => s.details.pages.security.whitelistSize,
      value: (p) => p.whitelist?.entries_total ?? null,
      format: "integer",
    },
  ],

  navigation: {
    // Five tabs rather than §23.3's four. The spec names the four rankings
    // and says nothing about posture, but the `security` topic also carries
    // posture/whitelist/effective limits and this page is the only screen
    // in Пульс that shows them. Posture comes FIRST because it is the half
    // that always has data: landing on a ranking would show an R5 gated
    // notice as the first thing a reader sees whenever runtime_edge is off,
    // with the working half hidden behind a tab.
    tabs: [
      {
        id: "posture",
        label: (s) => s.details.pages.security.tabs.posture,
        sections: [
          "posture",
          "whitelist",
          "whitelist_entries",
          "limits",
          "limits_timeouts",
          "limits_upstream",
          "limits_middle_proxy",
          "limits_user_ip",
          "limits_user_tcp",
        ],
      },
      // The four ranking tabs carry their size as a badge (up-sec-desktop
      // .png): «По IP 50» answers "is there anything in there" without a
      // tab switch, and an absent TLS payload leaves the badge off rather
      // than printing a 0 that would read as "measured, and it is zero".
      {
        id: "by_fingerprint",
        label: (s) => s.details.pages.security.tabs.byFingerprint,
        sections: ["capture", "by_fingerprint"],
        count: (p) => scopeCount(p, "by_fingerprint"),
      },
      {
        id: "by_ip",
        label: (s) => s.details.pages.security.tabs.byIp,
        sections: ["by_ip"],
        count: (p) => scopeCount(p, "by_ip"),
      },
      {
        id: "by_cidr",
        label: (s) => s.details.pages.security.tabs.byCidr,
        sections: ["by_cidr"],
        count: (p) => scopeCount(p, "by_cidr"),
      },
      {
        id: "by_user",
        label: (s) => s.details.pages.security.tabs.byUser,
        sections: ["by_user"],
        count: (p) => scopeCount(p, "by_user"),
      },
    ],
  },

  sections: [
    {
      kind: "scalars",
      id: "posture",
      title: (s) => s.details.pages.security.posture,
      sourceId: "security",
      defaultExpanded: true,
      fields: [
        { path: "posture.api_read_only" },
        { path: "posture.api_whitelist_enabled" },
        { path: "posture.api_whitelist_entries" },
        { path: "posture.api_auth_header_enabled" },
        { path: "posture.proxy_protocol_enabled" },
        { path: "posture.log_level" },
        { path: "posture.telemetry_core_enabled" },
        { path: "posture.telemetry_user_enabled" },
        { path: "posture.telemetry_me_level" },
      ],
    },
    {
      kind: "scalars",
      id: "whitelist",
      title: (s) => s.details.pages.security.whitelist,
      sourceId: "security",
      defaultExpanded: true,
      fields: [
        { path: "whitelist.enabled" },
        { path: "whitelist.entries_total" },
        { path: "whitelist.generated_at_epoch_secs" },
      ],
    },
    // §10.1: a list of addresses is a LIST — never a comma-joined row and
    // never "N items". Empty and absent stay different states (§10.3).
    {
      kind: "array",
      id: "whitelist_entries",
      title: () => "whitelist.entries[]",
      description: (s) => s.details.pages.security.whitelistEntries,
      sourceId: "security",
      path: "whitelist.entries",
    },
    {
      kind: "scalars",
      id: "limits",
      title: (s) => s.details.pages.security.limits,
      sourceId: "security",
      fields: [
        { path: "effective_limits.update_every_secs" },
        { path: "effective_limits.me_reinit_every_secs" },
        { path: "effective_limits.me_pool_force_close_secs" },
      ],
    },
    {
      kind: "scalars",
      id: "limits_timeouts",
      title: (s) => s.details.pages.security.limitsTimeouts,
      sourceId: "security",
      fields: [
        { path: "effective_limits.timeouts.client_first_byte_idle_secs" },
        { path: "effective_limits.timeouts.client_handshake_secs" },
        { path: "effective_limits.timeouts.tg_connect_secs" },
        { path: "effective_limits.timeouts.client_keepalive_secs" },
        { path: "effective_limits.timeouts.client_ack_secs" },
        { path: "effective_limits.timeouts.me_one_retry" },
        { path: "effective_limits.timeouts.me_one_timeout_ms" },
      ],
    },
    {
      kind: "scalars",
      id: "limits_upstream",
      title: (s) => s.details.pages.security.limitsUpstream,
      sourceId: "security",
      fields: [
        { path: "effective_limits.upstream.connect_retry_attempts" },
        { path: "effective_limits.upstream.connect_retry_backoff_ms" },
        { path: "effective_limits.upstream.connect_budget_ms" },
        { path: "effective_limits.upstream.unhealthy_fail_threshold" },
        { path: "effective_limits.upstream.connect_failfast_hard_errors" },
      ],
    },
    // A dynamic map rather than a scalar list, because
    // EffectiveMiddleProxyLimits is `Record<string, unknown>` — a
    // forward-compatible dump of internal pool knobs. A knob a future
    // Telemt adds appears here on its own instead of falling into the
    // unknown tail, which is exactly §11.2's contract for a map.
    {
      kind: "dynamicMap",
      id: "limits_middle_proxy",
      title: (s) => s.details.pages.security.limitsMiddleProxy,
      sourceId: "security",
      path: "effective_limits.middle_proxy",
    },
    {
      kind: "scalars",
      id: "limits_user_ip",
      title: (s) => s.details.pages.security.limitsUserIp,
      sourceId: "security",
      fields: [
        { path: "effective_limits.user_ip_policy.global_each" },
        { path: "effective_limits.user_ip_policy.mode" },
        { path: "effective_limits.user_ip_policy.window_secs" },
      ],
    },
    {
      kind: "scalars",
      id: "limits_user_tcp",
      title: (s) => s.details.pages.security.limitsUserTcp,
      sourceId: "security",
      fields: [{ path: "effective_limits.user_tcp_policy.global_each" }],
    },
    // The capture bounds sit on the fingerprints tab: they describe the
    // buffer every ranking below is read out of.
    {
      kind: "scalars",
      id: "capture",
      title: (s) => s.details.pages.security.capture,
      sourceId: "tls",
      fields: [
        { path: "limit" },
        { path: "retention_secs" },
        { path: "capacity" },
        { path: "dropped_total" },
        { path: "parse_error_total" },
      ],
    },
    tlsRanking("by_fingerprint", (row) => row.ja4),
    tlsRanking("by_ip", (row) => row.scope ?? row.ja4),
    tlsRanking("by_cidr", (row) => row.scope ?? row.ja4),
    tlsRanking("by_user", (row) => row.scope ?? row.ja4),
  ],

  unknownFields: { minMode: "extended", rawJson: true },
};
