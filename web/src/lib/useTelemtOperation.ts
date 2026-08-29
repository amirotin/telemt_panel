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
 * How often an in-flight operation is re-polled. One second: a close of a
 * handful of sessions finishes inside Telemt's first 128-candidate chunk,
 * so this is usually one extra request, and a slower cadence would leave
 * the confirmation dialog's result hanging for no reason.
 */
export const OPERATION_POLL_MS = 1000;

/**
 * A `refetchInterval` that polls until `isTerminal(data)` and then stops.
 * Written as a factory rather than inlined so the terminal RULE and the
 * cadence stay in one place for both operation kinds.
 */
export function pollUntilTerminal<TData>(
  isTerminal: (data: TData) => boolean,
  intervalMs: number = OPERATION_POLL_MS,
): (query: { state: { data?: TData | undefined } }) => number | false {
  return (query) => {
    const data = query.state.data;
    return data !== undefined && isTerminal(data) ? false : intervalMs;
  };
}

export type WebOperationState = WebControlOperationStatus["state"];

/** The states an operation can no longer move out of (web/manager/control.rs). */
export function isTerminalWebOperationState(state: WebOperationState): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

/**
 * useTelemtOperation polls one WEB control operation until it is terminal.
 * `operationId === null` means "nothing in flight" — the query is disabled
 * and never fires.
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
