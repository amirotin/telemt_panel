import type { ReactNode } from "react";
import { Skeleton } from "../ui/Skeleton";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { StatePill } from "../ui/StatePill";
import { ru, errorMessage } from "../i18n/ru";
import { Gated, type GatedProps } from "../caps/Gated";

export interface AsyncStateProps<T> {
  isPending: boolean;
  isError: boolean;
  /** The failed query's envelope {code}, when available — mapped via errorMessage(). */
  errorCode?: string;
  data: T | undefined;
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
  /** SSE topic staleness (useSnapshot's `.stale`) — shown as a non-blocking badge. */
  stale?: boolean;
  staleLabel?: string;
  /** A capability/gate this screen depends on — checked before anything else. */
  gate?: { enabled: boolean; reason?: string; hint?: GatedProps["hint"] };
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}

// AsyncState maps TanStack Query status + SSE staleness into the five
// mandatory per-screen states (06-ui.md: loading / empty / error / stale /
// degraded), so pages compose this instead of hand-rolling the same five
// branches on every screen.
export function AsyncState<T>({
  isPending,
  isError,
  errorCode,
  data,
  isEmpty,
  emptyTitle,
  emptyDescription,
  onRetry,
  stale,
  staleLabel,
  gate,
  skeleton,
  children,
}: AsyncStateProps<T>) {
  if (gate && !gate.enabled) {
    return <Gated enabled={false} reason={gate.reason} hint={gate.hint} />;
  }
  if (isPending) return <>{skeleton ?? <Skeleton className="h-24 w-full" />}</>;
  if (isError) {
    return (
      <ErrorState
        message={errorCode ? errorMessage(errorCode) : errorMessage("internal_error")}
        onRetry={onRetry}
      />
    );
  }
  if (data === undefined) return null;
  if (isEmpty?.(data) && emptyTitle) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <>
      {stale && (
        <StatePill state="warn" className="mb-2">
          {staleLabel ?? ru.common.stale}
        </StatePill>
      )}
      {children(data)}
    </>
  );
}
