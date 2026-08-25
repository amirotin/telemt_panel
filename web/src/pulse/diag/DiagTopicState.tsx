import type { ReactNode } from "react";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { StatePill } from "../../ui/StatePill";
import { errorMessage, useStrings } from "../../i18n";
import { decideDiagTopicState } from "./DiagTopicState.helpers";

export interface DiagTopicStateProps<T> {
  /**
   * The field-level payload this page renders (e.g. `topic.data?.upstreams
   * ?? null`) — may still be null even once the owning topic itself has
   * loaded (a per-field gate/decode gap), which is why this is separate
   * from `error`/`stale` below.
   */
  data: T | null | undefined;
  /** The owning topic's `useSnapshot().error`. */
  error: string | null;
  /** The owning topic's `useSnapshot().stale`. */
  stale: boolean;
  onRetry: () => void;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}

// DiagTopicState — the shared five-states wrapper every Диагностика
// drill-down page renders its topic through (06-ui.md §Состояния): no data
// + error -> ErrorState + retry; data present + stale -> data with the same
// stale StatePill badge WidgetFrame/AsyncState use; no data + no error +
// not stale -> Skeleton. Each page still owns its own field-level `Gated`
// branching inside `children` — this only replaces the hand-rolled
// Skeleton-or-nothing check every page used to open with.
export function DiagTopicState<T>({ data, error, stale, onRetry, skeleton, children }: DiagTopicStateProps<T>) {
  const s = useStrings();
  const decision = decideDiagTopicState(data, error, stale);
  if (decision.kind === "skeleton") return <>{skeleton ?? <Skeleton className="h-24 w-full" />}</>;
  if (decision.kind === "error") {
    return <ErrorState message={errorMessage(s, error ?? "internal_error")} onRetry={onRetry} />;
  }
  return (
    <>
      {decision.stale && (
        <StatePill state="warn" className="mb-2">
          {s.common.stale}
        </StatePill>
      )}
      {children(data as T)}
    </>
  );
}
