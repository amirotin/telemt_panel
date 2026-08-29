// The WEB Details page (M4 task 8b) — Telemt >= 3.5.3's WEB proxy mode, the
// first domain the panel can also ACT on.
//
// Two tabs, because the domain really is two things:
//
//   * Обзор — the process view of one WEB runtime: its lifecycle, the
//     listeners it bound, and the six capacity planes plus the permits and
//     limits that bound them. It comes from the `web` SSE topic, so every
//     open browser shares one poll.
//   * Сессии — the live sessions, fetched on visit and paged by Telemt's own
//     opaque cursor. It is not in the topic for the same reason the TLS
//     capture report is not: a page of sessions has no business being
//     re-polled for every connected client, and the filters are per-reader.
//
// The six planes arrive as `null` whenever their try_lock was contended for
// that poll, with their names in `partial[]`. That is NOT "absent": the page
// puts a «плоскость занята» badge on the section (WebPage supplies it
// through sectionExtras) and leaves the rows reading as unavailable, so a
// momentary lock never looks like a Telemt that stopped reporting.
//
// R6 (sensitive data): a session row carries a client IP, a username and a
// user agent. All three are shown to the admin verbatim, as everywhere else
// on these pages — they are that admin's own operational data. No copy menu.

import type { WebSessionRow } from "../../../lib/api/generated/types.gen";
import type { WebPagePayload } from "../../diag/web.helpers";
import type { DetailPageDefinition, SummaryTone } from "../model";

export const WEB_PAGE_ID = "pulse.web";

/**
 * The field catalog is ENDPOINT-scoped for this domain (ruling R9), the way
 * the TLS report is — the scope constant lives beside the entries it scopes.
 */
export { WEB_ENDPOINT } from "../fieldCatalog";

export const WEB_TAB_OVERVIEW = "overview";
export const WEB_TAB_SESSIONS = "sessions";

/** Section ids WebPage attaches live extras to (badges, paging, actions). */
export const WEB_SECTION_SESSIONS = "sessions";
export const WEB_PLANE_SECTIONS = {
  manager: "manager",
  streams: "streams",
  budget: "budget",
  websockets: "websockets",
  learning: "learning",
  debug: "debug",
} as const;

/** Which sections each tab shows — referenced by the tab definitions above. */
const WEB_TAB_OVERVIEW_SECTIONS = [
  "lifecycle",
  "listeners",
  "runtime",
  WEB_PLANE_SECTIONS.manager,
  WEB_PLANE_SECTIONS.streams,
  WEB_PLANE_SECTIONS.budget,
  WEB_PLANE_SECTIONS.websockets,
  WEB_PLANE_SECTIONS.learning,
  WEB_PLANE_SECTIONS.debug,
  "debug_policy",
  "permits",
  "limits",
  "totals",
  "partial",
];

const WEB_TAB_SESSIONS_SECTIONS = [WEB_SECTION_SESSIONS, "scan", "sessions_partial"];

/** Page-state filter keys, shared by the list control and the close-by-filter action. */
export const WEB_FILTER_CARRIER = "web.carrier";
export const WEB_FILTER_STATE = "web.state";
export const WEB_FILTER_USER = "web.user";

/** Telemt's own carrier and session-state vocabularies (web_carrier.rs, session/status.rs). */
export const WEB_CARRIERS = ["https", "https-lanes", "websocket", "websocket-lanes"] as const;
export const WEB_SESSION_STATES = [
  "provisional",
  "replacing",
  "committed",
  "superseded",
  "healthy",
  "closing",
  "closed",
] as const;

const sessionOf = (item: unknown) => item as WebSessionRow;

/** Stable semantic key (§5.3): Telemt's own opaque session reference. */
export function webSessionKey(row: Pick<WebSessionRow, "session_ref">): string {
  return row.session_ref;
}

/**
 * The lifecycle tone. `no_web_listener`/`drained` are NEUTRAL, not bad: a
 * WEB runtime that is deliberately off is a configuration, not a fault, and
 * painting it red would train an operator to ignore the colour.
 */
export function webLifecycleTone(lifecycle: string | undefined): SummaryTone {
  switch (lifecycle) {
    case "running":
      return "good";
    case "starting":
    case "draining":
      return "warn";
    case "deadline_exceeded":
      return "bad";
    default:
      return "neutral";
  }
}

export const webPageDefinition: DetailPageDefinition<WebPagePayload, WebPagePayload> = {
  id: WEB_PAGE_ID,
  title: (s) => s.details.pages.web.title,
  description: (s) => s.details.pages.web.description,

  sources: [
    // The status is REQUIRED: with no WEB runtime there is nothing on this
    // page at all, and the gate notice is the honest screen.
    { id: "status", topic: "web", required: true, capabilityPath: "status" },
    // The sessions are OPTIONAL: an Overview that renders while the session
    // fetch is still in flight (or has failed) is better than a page-level
    // error over data that is right there (§14).
    { id: "sessions", endpoint: "/api/telemt/web/sessions", required: false },
  ],

  navigation: {
    tabs: [
      {
        id: WEB_TAB_OVERVIEW,
        label: (s) => s.details.pages.web.tabOverview,
        sections: WEB_TAB_OVERVIEW_SECTIONS,
      },
      {
        id: WEB_TAB_SESSIONS,
        label: (s) => s.details.pages.web.tabSessions,
        sections: WEB_TAB_SESSIONS_SECTIONS,
        count: (p) => p.sessions?.rows.length ?? null,
      },
    ],
  },

  summary: [
    {
      id: "lifecycle",
      path: "lifecycle",
      value: (p) => p.lifecycle ?? null,
      format: "enum",
      tone: (p) => webLifecycleTone(p.lifecycle),
    },
    {
      id: "sessions",
      path: "runtime.manager.sessions",
      value: (p) => p.runtime?.manager?.sessions ?? null,
      format: "integer",
    },
    {
      id: "streams",
      path: "runtime.streams.live",
      value: (p) => p.runtime?.streams?.live ?? null,
      format: "integer",
    },
    {
      id: "bytes_down",
      path: "runtime.bytes_down",
      value: (p) => p.runtime?.bytes_down ?? null,
      unit: "bytes",
    },
    {
      id: "limit_hits",
      path: "runtime.limit_hits",
      value: (p) => p.runtime?.limit_hits ?? null,
      format: "integer",
      // A limit hit is a session or stream Telemt refused. Non-zero is
      // worth a look; it is not an outage.
      tone: (p) => ((p.runtime?.limit_hits ?? 0) > 0 ? "warn" : "good"),
    },
  ],

  sections: [
    // --- Обзор ---------------------------------------------------------
    {
      kind: "scalars",
      id: "lifecycle",
      title: (s) => s.details.pages.web.lifecycle,
      description: (s) => s.details.pages.web.lifecycleDescription,
      sourceId: "status",
      defaultExpanded: true,
      fields: [
        { path: "lifecycle" },
        { path: "available" },
        { path: "reason" },
        { path: "effective_config_enabled" },
        { path: "lifecycle_epoch" },
        { path: "lifecycle_age_ms" },
      ],
    },
    {
      kind: "array",
      id: "listeners",
      // Telemt's own field name (§11.2).
      title: () => "listeners[]",
      description: (s) => s.details.pages.web.listenersDescription,
      sourceId: "status",
      path: "listeners",
      defaultExpanded: true,
    },
    {
      kind: "scalars",
      id: "runtime",
      title: (s) => s.details.pages.web.runtime,
      description: (s) => s.details.pages.web.runtimeDescription,
      sourceId: "status",
      fields: [{ path: "runtime.runtime_instance" }, { path: "runtime.generation_id" }],
    },
    {
      kind: "scalars",
      id: WEB_PLANE_SECTIONS.manager,
      title: (s) => s.details.pages.web.manager,
      // A CONTENDED plane arrives as an explicit null, which makes
      // `runtime.<plane>` itself a leaf — and a leaf nobody claims lands in
      // the §24 unknown tail, which would read as "a field the panel does
      // not understand" for something it understands perfectly well.
      // `alsoConsumes` claims a path only WHILE it is a leaf, so this is
      // exactly the null case and never swallows the populated plane.
      alsoConsumes: ["runtime.manager"],
      description: (s) => s.details.pages.web.managerDescription,
      sourceId: "status",
      fields: [
        { path: "runtime.manager.issuance_enabled" },
        { path: "runtime.manager.issuance_generation" },
        { path: "runtime.manager.shutdown" },
        { path: "runtime.manager.sessions" },
        { path: "runtime.manager.bootstraps" },
        { path: "runtime.manager.client_ips" },
        { path: "runtime.manager.profiles" },
        { path: "runtime.manager.closed_sessions" },
        { path: "runtime.manager.closed_tokens" },
      ],
    },
    {
      kind: "scalars",
      id: WEB_PLANE_SECTIONS.streams,
      title: (s) => s.details.pages.web.streams,
      alsoConsumes: ["runtime.streams"],
      description: (s) => s.details.pages.web.streamsDescription,
      sourceId: "status",
      fields: [
        { path: "runtime.streams.live" },
        { path: "runtime.streams.profiles" },
        { path: "runtime.streams.closed" },
      ],
    },
    {
      kind: "scalars",
      id: WEB_PLANE_SECTIONS.budget,
      title: (s) => s.details.pages.web.budget,
      alsoConsumes: ["runtime.budget"],
      description: (s) => s.details.pages.web.budgetDescription,
      sourceId: "status",
      fields: [
        { path: "runtime.budget.queue_bytes" },
        { path: "runtime.budget.queue_items" },
        { path: "runtime.budget.control_bytes" },
        { path: "runtime.budget.control_items" },
        { path: "runtime.budget.websocket_bytes" },
        { path: "runtime.budget.high_water_bytes" },
        { path: "runtime.budget.owners" },
        { path: "runtime.budget.closed" },
      ],
    },
    {
      kind: "scalars",
      id: WEB_PLANE_SECTIONS.websockets,
      title: (s) => s.details.pages.web.websockets,
      alsoConsumes: ["runtime.websockets"],
      description: (s) => s.details.pages.web.websocketsDescription,
      sourceId: "status",
      fields: [
        { path: "runtime.websockets.entries" },
        { path: "runtime.websockets.claims" },
        { path: "runtime.websockets.evictions_in_flight" },
        { path: "runtime.websockets.closed" },
      ],
    },
    {
      kind: "scalars",
      id: WEB_PLANE_SECTIONS.learning,
      title: (s) => s.details.pages.web.learning,
      alsoConsumes: ["runtime.learning"],
      description: (s) => s.details.pages.web.learningDescription,
      sourceId: "status",
      fields: [
        { path: "runtime.learning.enabled" },
        { path: "runtime.learning.aggressiveness" },
        { path: "runtime.learning.entries" },
        { path: "runtime.learning.capacity" },
        { path: "runtime.learning.lifetime_secs" },
        { path: "runtime.learning.age_ms" },
        { path: "runtime.learning.epoch" },
      ],
    },
    {
      kind: "scalars",
      id: WEB_PLANE_SECTIONS.debug,
      title: (s) => s.details.pages.web.debug,
      alsoConsumes: ["runtime.debug"],
      description: (s) => s.details.pages.web.debugDescription,
      sourceId: "status",
      fields: [
        { path: "runtime.debug.records" },
        { path: "runtime.debug.records_capacity" },
        { path: "runtime.debug.used_bytes" },
        { path: "runtime.debug.bytes_capacity" },
        { path: "runtime.debug.earliest_seq" },
        { path: "runtime.debug.latest_seq" },
        { path: "runtime.debug.contention_drops" },
        { path: "runtime.debug.evictions" },
        { path: "runtime.debug.byte_truncations" },
        { path: "runtime.debug.epoch" },
        { path: "runtime.debug.policy_generation" },
      ],
    },
    {
      // The capture policy is a Telemt config table the panel neither edits
      // nor interprets. An ungrouped dynamic map owns its whole subtree, so
      // a knob a future Telemt adds shows up as a row rather than as a lost
      // leaf (§11.2, §27.4).
      kind: "dynamicMap",
      id: "debug_policy",
      title: (s) => s.details.pages.web.debugPolicy,
      description: (s) => s.details.pages.web.debugPolicyDescription,
      sourceId: "status",
      path: "runtime.debug.policy",
      minMode: "extended",
    },
    {
      kind: "array",
      id: "permits",
      // Telemt's own field name; the rows are its own semaphore names.
      title: () => "permits[]",
      description: (s) => s.details.pages.web.permitsDescription,
      sourceId: "status",
      path: "runtime.permits",
    },
    {
      // The process-deferred knobs (46 of them on 3.5.5). Same reasoning as
      // the capture policy.
      kind: "dynamicMap",
      id: "limits",
      title: (s) => s.details.pages.web.limits,
      description: (s) => s.details.pages.web.limitsDescription,
      sourceId: "status",
      path: "runtime.limits",
      minMode: "extended",
    },
    {
      kind: "scalars",
      id: "totals",
      title: (s) => s.details.pages.web.totals,
      description: (s) => s.details.pages.web.totalsDescription,
      sourceId: "status",
      fields: [
        { path: "runtime.bytes_up" },
        { path: "runtime.bytes_down" },
        { path: "runtime.streams_opened" },
        { path: "runtime.streams_rejected" },
        { path: "runtime.session_incarnations_created" },
        { path: "runtime.session_incarnations_closed" },
        { path: "runtime.limit_hits" },
        { path: "runtime.auxiliary_tasks" },
      ],
    },
    {
      kind: "array",
      id: "partial",
      title: () => "partial[]",
      description: (s) => s.details.pages.web.partialDescription,
      sourceId: "status",
      path: "runtime.partial",
    },

    // --- Сессии ---------------------------------------------------------
    {
      kind: "entityList",
      id: WEB_SECTION_SESSIONS,
      title: (s) => s.details.pages.web.sessions,
      description: (s) => s.details.pages.web.sessionsDescription,
      sourceId: "sessions",
      path: "sessions.rows",
      defaultExpanded: true,
      itemKey: (item) => webSessionKey(sessionOf(item)),
      // The CLIENT names the row and the carrier/state/user line explains
      // it — Telemt's own strings, printed verbatim (§11.2). The opaque
      // `session_ref` is in the surface: it identifies the row for a close
      // request, it does not tell a reader who this is.
      identity: (item) => sessionOf(item).client_ip,
      status: (item) => {
        const row = sessionOf(item);
        return `${row.user} · ${row.carrier} · ${row.state}`;
      },
      highlights: ["streams", "age_ms"],
      search: {
        terms: (item) => {
          const row = sessionOf(item as WebSessionRow);
          return [
            row.session_ref,
            row.client_ip,
            row.user,
            row.host,
            row.key_id,
            row.carrier,
            row.state,
            row.user_agent ?? "",
          ];
        },
      },
      filters: [
        {
          key: WEB_FILTER_CARRIER,
          label: (s) => s.details.pages.web.filterCarrier,
          options: WEB_CARRIERS.map((carrier) => ({
            value: carrier,
            // Telemt's own token: shown as it is.
            label: () => carrier,
          })),
          predicate: (item, value) => sessionOf(item).carrier === value,
        },
        {
          key: WEB_FILTER_STATE,
          label: (s) => s.details.pages.web.filterState,
          options: WEB_SESSION_STATES.map((state) => ({
            value: state,
            label: () => state,
          })),
          predicate: (item, value) => sessionOf(item).state === value,
        },
        {
          key: WEB_FILTER_USER,
          label: (s) => s.details.pages.web.filterUser,
          // The value set is DATA — the users with a live WEB session right
          // now — so it is derived from the loaded rows rather than listed
          // here. `[access.users]` may hold a hundred names of which two
          // have a WEB profile, and a select of a hundred dead options is
          // not a filter.
          optionsFrom: (items) =>
            [...new Set(items.map((item) => sessionOf(item).user))]
              .sort()
              .map((user) => ({ value: user, label: () => user })),
          predicate: (item, value) => sessionOf(item).user === value,
        },
      ],
    },
    {
      kind: "scalars",
      id: "scan",
      title: (s) => s.details.pages.web.scan,
      description: (s) => s.details.pages.web.scanDescription,
      sourceId: "sessions",
      fields: [
        { path: "sessions.scanned" },
        { path: "sessions.scan_truncated" },
        { path: "sessions.partial_sessions" },
        { path: "sessions.next_cursor" },
      ],
    },
    {
      kind: "array",
      id: "sessions_partial",
      title: () => "sessions.partial[]",
      description: (s) => s.details.pages.web.sessionsPartialDescription,
      sourceId: "sessions",
      path: "sessions.partial",
    },
  ],

  unknownFields: { minMode: "extended", rawJson: true },
};
