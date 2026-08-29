import { useEffect, useRef } from "react";
import { fill, useStrings } from "../../i18n";
import type { WebControlOperationStatus } from "../../lib/api/generated/types.gen";
import { isTerminalWebOperationState } from "../../lib/useTelemtOperation";
import { apiErrorMessage } from "../../people/apiError";
import { pushToast } from "../../ui/Toast";

// Reporting the outcome of one WEB close operation, exactly once.
//
// Lifted out of WebPage's body because it was a bare `if` during RENDER that
// called pushToast and invalidateQueries. The setState half of that pattern
// is legitimate derived state; the two side effects are not — <StrictMode>
// double-invokes render with the pre-update guard, so both toasts could fire
// twice, and a cache invalidation during render is a purity violation in any
// environment. As an effect with a ref guard it is also testable in
// isolation, which the render-phase version was not.

export interface WebCloseReportInput {
  /** The operation being polled, or null when nothing is in flight. */
  operationId: string | null;
  /** The last status the poll returned, if any. */
  data: WebControlOperationStatus | undefined;
  /** The poll's error, if the last request failed. */
  error: unknown;
  /** Stop polling: the operation has settled, one way or the other. */
  onSettled: () => void;
  /** The session registry moved — reload it. */
  onRegistryMoved: () => void;
}

export function useWebCloseReport({
  operationId,
  data,
  error,
  onSettled,
  onRegistryMoved,
}: WebCloseReportInput): void {
  const s = useStrings();
  // A ref, not state: the guard must not schedule a render of its own, and
  // it must survive StrictMode's re-invocation of the effect. The callbacks
  // stay in the deps rather than being held in refs — an unstable one just
  // re-runs the effect, which the guard then leaves immediately.
  const reportedFor = useRef<string | null>(null);

  const state = data?.state;
  useEffect(() => {
    if (data === undefined || state === undefined) return;
    if (!isTerminalWebOperationState(state)) return;
    if (reportedFor.current === data.operation_id) return;
    reportedFor.current = data.operation_id;
    if (state === "completed") {
      pushToast(
        fill(s.details.pages.web.closeDoneTemplate, { count: String(data.close_signalled) }),
        "ok",
      );
      if (data.conflicted > 0) {
        pushToast(
          fill(s.details.pages.web.closeConflictTemplate, { count: String(data.conflicted) }),
          "default",
        );
      }
    } else {
      pushToast(s.details.pages.web.closeFailed, "error");
    }
    // Disabling the query is what actually stops the poll — relying on the
    // schedule to keep answering `false` would leave a live observer on a
    // finished operation.
    onSettled();
    onRegistryMoved();
  }, [data, state, s, onSettled, onRegistryMoved]);

  // A FAILED poll is an answer too. Telemt keeps only the last 32
  // operations, so an aged-out id answers 404 web_operation_not_found for
  // the life of the page, and a restarted proxy answers 409
  // web_runtime_mismatch — neither of which is worth waiting the schedule's
  // cap out for.
  const failedFor = useRef<string | null>(null);
  useEffect(() => {
    if (operationId === null || error === null || error === undefined) return;
    if (failedFor.current === operationId) return;
    failedFor.current = operationId;
    pushToast(apiErrorMessage(error, s), "error");
    onSettled();
  }, [operationId, error, s, onSettled]);
}
