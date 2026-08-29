// The Connections Details page (spec §23.5), as a declarative definition.
//
// What it replaces: `connectionsGroups` flattened `top.by_connections` and
// `top.by_throughput` into two KV groups of thirty rows — three rows per
// user, twice, with no order a reader could change and no way to search.
// §23.5 makes them what they are: «два рейтинга одних сущностей по разным
// критериям», one RankingSection each.
//
// TWO halves with different availability, and the always-on one comes
// FIRST (the same reasoning ruling R10 applied to Security): `GET
// /v1/stats/summary` is never gated, while `connections_summary` sits
// behind runtime_edge. Landing on a gate notice while the page HAS data to
// show would break §14's promise that a switched-off capability never
// blanks a screen.
//
// R6 (sensitive data) is unchanged: a username is the admin's own data and
// is shown verbatim, secrets are not involved here, and no copy menu is
// attached.

import { fill } from "../../../i18n";
import { formatBytes } from "../../../lib/format";
import type {
  RuntimeEdgeConnectionUser,
  RuntimeEdgeConnectionsSummary,
  StatsSummary,
} from "../../../realtime/topics";
import type { FormatterName } from "../formatting";
import type { DetailPageDefinition, RankingSectionDefinition, SummaryTone } from "../model";

export interface ConnectionsPagePayload {
  /** `GET /v1/stats/summary` — always on. */
  summary?: StatsSummary;
  /** Sum of every user's lifetime `total_octets`, from the `users` topic. */
  users_traffic_total?: number;
  /** The four blocks of `GET /v1/runtime/connections/summary`, spread flat. */
  cache?: RuntimeEdgeConnectionsSummary["cache"];
  totals?: RuntimeEdgeConnectionsSummary["totals"];
  top?: RuntimeEdgeConnectionsSummary["top"];
  telemetry?: RuntimeEdgeConnectionsSummary["telemetry"];
}

export const CONNECTIONS_PAGE_ID = "pulse.connections";

const userOf = (item: unknown) => item as RuntimeEdgeConnectionUser;

/** The two criteria §17 ranks the same population by. */
export const CONNECTIONS_TOP_PATHS = ["by_connections", "by_throughput"] as const;
export type ConnectionsTopPath = (typeof CONNECTIONS_TOP_PATHS)[number];

// topRanking builds one of §23.5's two rankings. They differ in exactly two
// ways — which number ranks a row and which number is the footnote — so the
// shape is written once and the differences are arguments.
function topRanking(
  path: ConnectionsTopPath,
  score: (user: RuntimeEdgeConnectionUser) => number,
  scoreKey: "current_connections" | "total_octets",
  scoreFormat: FormatterName,
  meta: (user: RuntimeEdgeConnectionUser, s: import("../../../i18n").Dict) => string,
): RankingSectionDefinition<ConnectionsPagePayload, unknown> {
  return {
    kind: "ranking",
    id: path,
    // Telemt's own field name for the collection (§11.2); the sentence
    // under it is what gets translated.
    title: () => `top.${path}[]`,
    description: (s) => s.details.pages.connections.rankingDescription,
    sourceId: "connections",
    path: `top.${path}`,
    defaultExpanded: true,
    // The username IS the identity of the row (§5.3): a re-sort by Telemt
    // must not re-key a row that simply moved.
    itemKey: (item) => userOf(item).username,
    identity: (item) => userOf(item).username,
    score: (item) => score(userOf(item)),
    scoreKey,
    // A volume is printed as a volume: the octet count ranks the row, but
    // «44 ГБ» is what a reader can read at a glance (§13).
    scoreFormat,
    meta: (item, s) => meta(userOf(item), s),
    search: { terms: (item) => [userOf(item).username] },
    // The other numeric column, so a reader can flip the same ten rows to
    // the other criterion without leaving the section (§23.3's rule, which
    // §23.5 inherits).
    sort: [
      {
        key: scoreKey === "total_octets" ? "current_connections" : "total_octets",
        label: () => (scoreKey === "total_octets" ? "current_connections" : "total_octets"),
        compare: (a, b) =>
          scoreKey === "total_octets"
            ? userOf(b).current_connections - userOf(a).current_connections
            : userOf(b).total_octets - userOf(a).total_octets,
      },
    ],
  };
}

function badTone(payload: ConnectionsPagePayload): SummaryTone {
  const bad = payload.summary?.connections_bad_total;
  if (bad === undefined) return "neutral";
  return bad > 0 ? "warn" : "good";
}

export const connectionsPageDefinition: DetailPageDefinition<
  ConnectionsPagePayload,
  ConnectionsPagePayload
> = {
  id: CONNECTIONS_PAGE_ID,
  title: (s) => s.details.pages.connections.title,
  description: (s) => s.details.pages.connections.description,

  sources: [
    { id: "stats", topic: "stats", required: true },
    // connections_summary rides the runtime_edge gate. Optional: with it off
    // the page is `partial` and the always-on half above keeps working.
    { id: "connections", topic: "stats", required: false },
  ],

  summary: [
    {
      id: "current_connections",
      path: "totals.current_connections",
      value: (p) => p.totals?.current_connections ?? null,
      format: "integer",
    },
    {
      id: "active_users",
      path: "totals.active_users",
      value: (p) => p.totals?.active_users ?? null,
      format: "integer",
    },
    {
      id: "connections_total",
      path: "summary.connections_total",
      value: (p) => p.summary?.connections_total ?? null,
      format: "integer",
    },
    {
      id: "connections_bad_total",
      path: "summary.connections_bad_total",
      value: (p) => p.summary?.connections_bad_total ?? null,
      format: "integer",
      tone: badTone,
    },
  ],

  sections: [
    {
      kind: "scalars",
      id: "summary",
      title: (s) => s.details.pages.connections.summary,
      sourceId: "stats",
      defaultExpanded: true,
      fields: [
        { path: "summary.connections_total" },
        { path: "summary.connections_bad_total" },
        { path: "summary.handshake_timeouts_total" },
        { path: "summary.configured_users" },
        { path: "summary.uptime_seconds" },
        { path: "users_traffic_total" },
      ],
    },
    // §23.5: «Summary class/stage lists: BreakdownSection» — one row per
    // class with its share, never two KV rows per element.
    {
      kind: "breakdown",
      id: "connections_bad_by_class",
      title: () => "connections_bad_by_class[]",
      description: (s) => s.details.pages.connections.badByClass,
      sourceId: "stats",
      path: "summary.connections_bad_by_class",
      defaultExpanded: true,
    },
    {
      kind: "breakdown",
      id: "handshake_failures_by_class",
      title: () => "handshake_failures_by_class[]",
      description: (s) => s.details.pages.connections.handshakeByClass,
      sourceId: "stats",
      path: "summary.handshake_failures_by_class",
      defaultExpanded: true,
    },
    {
      kind: "scalars",
      id: "totals",
      title: (s) => s.details.pages.connections.totals,
      sourceId: "connections",
      defaultExpanded: true,
      fields: [
        { path: "totals.current_connections" },
        { path: "totals.current_connections_me" },
        { path: "totals.current_connections_direct" },
        { path: "totals.active_users" },
      ],
    },
    topRanking(
      "by_connections",
      (user) => user.current_connections,
      "current_connections",
      "integer",
      (user, s) =>
        fill(s.details.pages.connections.metaOctets, { bytes: formatBytes(user.total_octets, s) }),
    ),
    topRanking(
      "by_throughput",
      (user) => user.total_octets,
      "total_octets",
      "bytes",
      (user, s) =>
        fill(s.details.pages.connections.metaConnections, {
          count: String(user.current_connections),
        }),
    ),
    {
      kind: "scalars",
      id: "cache",
      title: (s) => s.details.pages.connections.cache,
      sourceId: "connections",
      fields: [
        { path: "cache.ttl_ms" },
        { path: "cache.served_from_cache" },
        { path: "cache.stale_cache_used" },
      ],
    },
    // How the two rankings above were produced: how many rows were asked
    // for, and what the numbers in them actually count.
    {
      kind: "scalars",
      id: "reporting",
      title: (s) => s.details.pages.connections.reporting,
      sourceId: "connections",
      fields: [
        { path: "top.limit" },
        { path: "telemetry.user_enabled" },
        { path: "telemetry.throughput_is_cumulative" },
      ],
    },
  ],

  unknownFields: { minMode: "extended", rawJson: true },
};
