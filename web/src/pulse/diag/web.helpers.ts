import type {
  WebCloseSelector,
  WebSessionPage,
  WebSessionRow,
} from "../../lib/api/generated/types.gen";
import type { Dict } from "../../i18n";
import {
  WEB_FILTER_CARRIER,
  WEB_FILTER_STATE,
  WEB_FILTER_USER,
} from "../details-builder/definitions/web";
import type { FilterValue } from "../details-builder/model";
import type {
  WebBudgetStatus,
  WebDebugStatus,
  WebLearningStatus,
  WebLimits,
  WebManagerStatus,
  WebPermitStatus,
  WebSocketsStatus,
  WebStatus,
  WebStreamStatus,
} from "../../realtime/topics";

// The WEB Details page's payload adapter (M4 task 8b).
//
// Two reshapes, both for the same reason the Events page nests its ring
// buffer: a path the field catalog can describe and the resolver can render.
//
//   * `runtime.permits` arrives as a Rust TUPLE array — pairs of
//     [name, {used, available, capacity, closed}]. Left alone it would
//     resolve as eight two-element arrays whose first element is a string
//     and whose second is an object, i.e. a nested array nobody can read and
//     no catalog entry can name. Here it becomes a plain array of records
//     with `name` as an ordinary field: the name is Telemt's own string,
//     printed verbatim (§11.2), nothing is invented.
//   * `sessions.sessions` becomes `sessions.rows`, so a path reads
//     `sessions.rows[0].client_ip` rather than `sessions.sessions[0]...`.
//
// Everything else keeps Telemt's own spelling, including the six planes'
// null-when-contended semantics and the `partial[]` list that names them.

/** One row of the reshaped permits table. */
export interface WebPermitRow extends WebPermitStatus {
  /** Telemt's own semaphore name, the tuple's first element. */
  name: string;
}

/** The live process state, with `permits` reshaped. */
export interface WebPageRuntime {
  runtime_instance: string;
  generation_id: number;
  limits: WebLimits;
  manager: WebManagerStatus | null;
  streams: WebStreamStatus | null;
  budget: WebBudgetStatus | null;
  websockets: WebSocketsStatus | null;
  learning: WebLearningStatus | null;
  debug: WebDebugStatus | null;
  permits: WebPermitRow[];
  auxiliary_tasks: number;
  session_incarnations_created: number;
  session_incarnations_closed: number;
  streams_opened: number;
  streams_rejected: number;
  bytes_up: number;
  bytes_down: number;
  limit_hits: number;
  partial: string[];
}

/**
 * The sessions half. `rows` accumulates every page loaded so far; the four
 * scan fields and the cursor come from the LAST page — they describe the
 * scan that produced the current tail, which is what a reader deciding
 * whether to load more actually needs.
 */
export interface WebPageSessions {
  rows: WebSessionRow[];
  next_cursor: string | null;
  scanned: number;
  scan_truncated: boolean;
  partial_sessions: number;
  partial: string[];
}

export interface WebPagePayload {
  lifecycle: string;
  lifecycle_epoch: number;
  lifecycle_age_ms: number;
  available: boolean;
  reason?: string;
  listeners: string[];
  effective_config_enabled: boolean;
  runtime?: WebPageRuntime | null;
  sessions?: WebPageSessions;
}

/** The six planes, in Telemt's own `partial[]` order. */
export const WEB_PLANES = [
  "manager",
  "streams",
  "budget",
  "websockets",
  "learning",
  "debug",
] as const;

export type WebPlane = (typeof WEB_PLANES)[number];

/**
 * True when this plane's lock was contended for the poll on screen. Read off
 * `partial[]` rather than off the plane being null, because those are two
 * halves of the same signal and only the list is authoritative about WHY.
 */
export function isWebPlaneBusy(payload: WebPagePayload | null, plane: WebPlane): boolean {
  return payload?.runtime?.partial?.includes(plane) ?? false;
}

function permitRows(
  permits: ReadonlyArray<readonly [string, WebPermitStatus]> | undefined,
): WebPermitRow[] {
  return (permits ?? []).map(([name, status]) => ({ name, ...status }));
}

/**
 * webPagePayload builds the page context from the `web` topic's status and
 * the accumulated session pages. Both halves are optional: the Overview
 * renders without the Sessions tab having been opened, and the Sessions tab
 * renders while the status poll is still in flight.
 */
export function webPagePayload(
  status: WebStatus | null | undefined,
  sessions: readonly WebSessionPage[] | null | undefined,
): WebPagePayload | null {
  if (!status) return null;
  const runtime = status.runtime;
  const pages = sessions ?? [];
  const last = pages[pages.length - 1];
  return {
    lifecycle: status.lifecycle,
    lifecycle_epoch: status.lifecycle_epoch,
    lifecycle_age_ms: status.lifecycle_age_ms,
    available: status.available,
    ...(status.reason !== undefined ? { reason: status.reason } : {}),
    listeners: status.listeners,
    effective_config_enabled: status.effective_config_enabled,
    ...(runtime
      ? {
          runtime: {
            runtime_instance: runtime.runtime_instance,
            generation_id: runtime.generation_id,
            limits: runtime.limits,
            manager: runtime.manager,
            streams: runtime.streams,
            budget: runtime.budget,
            websockets: runtime.websockets,
            learning: runtime.learning,
            debug: runtime.debug,
            permits: permitRows(runtime.permits),
            auxiliary_tasks: runtime.auxiliary_tasks,
            session_incarnations_created: runtime.session_incarnations_created,
            session_incarnations_closed: runtime.session_incarnations_closed,
            streams_opened: runtime.streams_opened,
            streams_rejected: runtime.streams_rejected,
            bytes_up: runtime.bytes_up,
            bytes_down: runtime.bytes_down,
            limit_hits: runtime.limit_hits,
            partial: runtime.partial,
          },
        }
      : {}),
    ...(last !== undefined
      ? {
          sessions: {
            rows: pages.flatMap((page) => page.sessions),
            next_cursor: last.next_cursor,
            scanned: last.scanned,
            scan_truncated: last.scan_truncated,
            partial_sessions: last.partial_sessions,
            partial: last.partial,
          },
        }
      : {}),
  };
}

/**
 * The runtime_instance a close request must carry as its process fence.
 * `null` while the status has not arrived or the runtime is closed — which
 * is exactly when the close action must not be offered.
 */
export function webRuntimeInstance(payload: WebPagePayload | null): string | null {
  return payload?.runtime?.runtime_instance ?? null;
}

/** Which confirmation step is open, if any. */
export type CloseIntent =
  { kind: "session"; ref: string } | { kind: "filter"; filters: Record<string, FilterValue> };

/** The close selector for one intent, in Telemt's own vocabulary. */
export function webCloseSelector(intent: CloseIntent): WebCloseSelector {
  if (intent.kind === "session") {
    return { kind: "refs", session_refs: [intent.ref] };
  }
  const carrier = intent.filters[WEB_FILTER_CARRIER];
  const state = intent.filters[WEB_FILTER_STATE];
  const user = intent.filters[WEB_FILTER_USER];
  const selector: WebCloseSelector = { kind: "filter" };
  if (typeof carrier === "string" && carrier !== "") selector.carrier = carrier as never;
  if (typeof state === "string" && state !== "") selector.state = state;
  if (typeof user === "string" && user !== "") selector.user = user;
  // A filter selector with nothing set is rejected by Telemt (and would mean
  // "every session" if it weren't). With no filter chosen the honest request
  // is the `all` selector, which Telemt refuses while issuance is enabled —
  // the operator is told to switch WEB off first rather than being handed a
  // silent no-op.
  return Object.keys(selector).length === 1 ? { kind: "all" } : selector;
}

/** The human summary of the filter a close-by-filter would apply. */
export function webFilterSummary(filters: Record<string, FilterValue>, s: Dict): string | null {
  const parts: string[] = [];
  for (const [key, label] of [
    [WEB_FILTER_CARRIER, s.details.pages.web.filterCarrier],
    [WEB_FILTER_STATE, s.details.pages.web.filterState],
    [WEB_FILTER_USER, s.details.pages.web.filterUser],
  ] as const) {
    const value = filters[key];
    if (typeof value === "string" && value !== "") parts.push(`${label}: ${value}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}
