import { useQuery } from "@tanstack/react-query";
import { getTelemtWebOperationOptions } from "./api/generated/@tanstack/react-query.gen";
import type { WebControlOperationStatus } from "./api/generated/types.gen";

// Polling an asynchronous Telemt operation to a terminal state.
//
// The panel now has two of these — the config reload
// (GET /api/telemt/reload/{id}, accepted→…→succeeded|rolled_back|failed) and
// the WEB session close (GET /api/telemt/web/operations/{id},
// queued→running→completed|cancelled|failed) — and they poll identically:
// a React Query whose `refetchInterval` returns false once the payload's
// `state` is terminal, with no hand-rolled effect or timer anywhere.
//
// `pollUntilTerminal` is that shared half, kept generic over the payload so
// server/config/useReloadPolling.ts can adopt it without this module
// learning anything about reloads. It is deliberately NOT migrated in this
// task: the reload stepper is a shipped, tested flow, and rewiring it to
// prove a refactor belongs in its own change.

/**
 * The first interval. One second: a close of a handful of sessions finishes
 * inside Telemt's first 128-candidate chunk, so this is usually one extra
 * request, and a slower opening cadence would leave the confirmation
 * dialog's result hanging for no reason.
 */
export const OPERATION_POLL_MS = 1000;

/** The interval the backoff settles at. */
export const OPERATION_POLL_MAX_MS = 5000;

/**
 * The hard cap, counted in answered polls rather than in seconds.
 *
 * It is what stops a permanently-failing poll: React Query keeps a
 * `refetchInterval` running while a query is in `error`, and Telemt retains
 * only the last 32 operations — so an id that ages out (404
 * web_operation_not_found) or a proxy that restarted (409
 * web_runtime_mismatch) would otherwise be re-asked once a second for the
 * life of the page. Forty polls under this backoff is a little over three
 * minutes, far longer than any close Telemt will run and far short of
 * forever.
 */
export const OPERATION_POLL_LIMIT = 40;

/** How the interval grows, and when it gives up. */
export interface PollSchedule {
  /** First interval, in ms (default OPERATION_POLL_MS). */
  startMs?: number;
  /** Ceiling the backoff settles at (default OPERATION_POLL_MAX_MS). */
  maxMs?: number;
  /** Answered polls after which the schedule stops (default OPERATION_POLL_LIMIT). */
  maxPolls?: number;
}

/** The slice of React Query's state the schedule reads. */
export interface PollQueryState<TData> {
  state: {
    data?: TData | undefined;
    dataUpdateCount: number;
    errorUpdateCount: number;
  };
}

/**
 * A `refetchInterval` that polls until `isTerminal(data)`, backing off as it
 * goes and giving up after `maxPolls`. Written as a factory rather than
 * inlined so the terminal RULE, the cadence and the cap stay in one place
 * for both operation kinds.
 *
 * Both counters are added together on purpose: an *error* is an answer as
 * far as the cap is concerned, and it is the failing case — not the slow
 * one — that this exists to bound.
 */
export function pollUntilTerminal<TData>(
  isTerminal: (data: TData) => boolean,
  schedule: PollSchedule = {},
): (query: PollQueryState<TData>) => number | false {
  const startMs = schedule.startMs ?? OPERATION_POLL_MS;
  const maxMs = schedule.maxMs ?? OPERATION_POLL_MAX_MS;
  const maxPolls = schedule.maxPolls ?? OPERATION_POLL_LIMIT;
  return (query) => {
    const data = query.state.data;
    if (data !== undefined && isTerminal(data)) return false;
    const answered = query.state.dataUpdateCount + query.state.errorUpdateCount;
    if (answered >= maxPolls) return false;
    return Math.min(maxMs, startMs * 2 ** Math.max(0, answered - 1));
  };
}

export type WebOperationState = WebControlOperationStatus["state"];

/** The states an operation can no longer move out of (web/manager/control.rs). */
export function isTerminalWebOperationState(state: WebOperationState): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

/**
 * useTelemtOperation polls one WEB control operation until it is terminal or
 * the schedule gives up. `operationId === null` means "nothing in flight" —
 * the query is disabled and never fires, which is also how the caller stops
 * the poll once it has reported the result, and what makes an unmounted page
 * hold no timer.
 */
export function useTelemtOperation(operationId: string | null) {
  return useQuery({
    ...getTelemtWebOperationOptions({ path: { id: operationId ?? "" } }),
    enabled: operationId !== null,
    refetchInterval: pollUntilTerminal<WebControlOperationStatus>((data) =>
      isTerminalWebOperationState(data.state),
    ),
  });
}
