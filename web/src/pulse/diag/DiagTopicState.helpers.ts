// DiagTopicState.helpers — the pure state-decision matrix behind
// DiagTopicState.tsx (closing fix wave F1): given a Диагностика page's
// field-level data plus its owning topic's outer error/stale
// (useSnapshot's TopicSnapshot), decides which of the three render
// branches applies. Kept separate from the component so the decision
// itself is unit-testable without React.
export type DiagTopicStateDecision =
  | { kind: "skeleton" }
  | { kind: "error" }
  | { kind: "ready"; stale: boolean };

export function decideDiagTopicState<T>(
  data: T | null | undefined,
  error: string | null,
  stale: boolean,
): DiagTopicStateDecision {
  if (data === null || data === undefined) {
    return error ? { kind: "error" } : { kind: "skeleton" };
  }
  return { kind: "ready", stale };
}
