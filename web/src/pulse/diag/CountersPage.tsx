import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getTelemtZeroOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { ZeroAllData } from "../../lib/api/generated/types.gen";
import { DetailPage } from "../details-builder/DetailPage";
import { countersPageDefinition } from "../details-builder/definitions/counters";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import {
  computeCounterDeltas,
  readCounterValues,
  type CounterSnapshot,
} from "./counters.helpers";

// countersRefetchMs: the poll that MAKES the deltas (ruling R4). The panel
// has no counter-history endpoint, so "change per second" is the difference
// between two consecutive answers — which means the interval is a product
// decision, not a caching one. Ten seconds is short enough that a reader who
// opens the page sees a rate within one breath, and long enough that a
// 4 KB dump every ten seconds costs the proxy nothing.
export const countersRefetchMs = 10_000;

/** One reading, plus when it was taken. */
interface Reading {
  values: CounterSnapshot;
  atMs: number;
}

interface DeltaState {
  /** `dataUpdatedAt` of the reading in `current` — the identity of a poll. */
  atMs: number;
  current: Reading | null;
  previous: Reading | null;
  baseline: Reading | null;
  /** Bumped by the reset control; a change re-seeds `baseline`. */
  token: number;
}

const EMPTY: DeltaState = { atMs: 0, current: null, previous: null, baseline: null, token: 0 };

// useCounterDeltas keeps R4's two comparison points in ROUTE MEMORY — this
// component's own state, never the URL and never storage: a delta describes
// one visit to one page, and sharing a link that claims a rate somebody else
// never measured would be a lie.
//
// The snapshot is state adjusted during render (React's own "adjusting state
// when props change" pattern, as in RankingSection's frozen order) rather
// than a ref: what it holds is rendered, and a ref written during render both
// trips the lint rule and fails to repaint when only the numbers moved.
function useCounterDeltas(data: ZeroAllData | undefined, dataUpdatedAt: number) {
  const [resetToken, setResetToken] = useState(0);
  const [state, setState] = useState<DeltaState>(EMPTY);

  let next = state;
  if (data !== undefined && dataUpdatedAt > 0 && dataUpdatedAt !== state.atMs) {
    const reading: Reading = { values: readCounterValues(data), atMs: dataUpdatedAt };
    next = {
      atMs: dataUpdatedAt,
      current: reading,
      previous: state.current,
      // The first response IS the baseline: "since you opened the page"
      // starts at zero, not at whatever Telemt has counted since boot.
      baseline: state.baseline ?? reading,
      token: resetToken,
    };
  }
  if (next.token !== resetToken && next.current !== null) {
    next = { ...next, baseline: next.current, token: resetToken };
  }
  if (next !== state) setState(next);

  const reset = useCallback(() => setResetToken((n) => n + 1), []);

  if (next.current === null) return { deltas: undefined, sinceOpen: undefined, reset };
  const { perSecond, sinceOpen } = computeCounterDeltas({
    previous: next.previous,
    baseline: next.baseline,
    current: next.current,
  });
  return {
    // Before the SECOND response there is nothing to compare against, and
    // the map's own control says so rather than printing zeros.
    deltas: next.previous === null ? undefined : perSecond,
    sinceOpen: next.baseline === next.current ? undefined : sinceOpen,
    reset,
  };
}

// CountersPage — /pulse/diag/counters, spec §23.4. The ~115 flat KV rows the
// old page produced are now five searchable, collapsible groups with a
// description under every key and R4's client-side deltas; the two
// `{class,total}` arrays and `handshake_error_codes` get breakdowns of their
// own instead of being nested rows.
export function CountersPage() {
  const navigate = useNavigate();
  const zero = useQuery({ ...getTelemtZeroOptions(), refetchInterval: countersRefetchMs });
  const { deltas, sinceOpen, reset } = useCounterDeltas(zero.data, zero.dataUpdatedAt);

  const inputs: Record<string, DetailSourceInput> = {
    zero: {
      kind: "query",
      isPending: zero.isPending,
      isError: zero.isError,
      error: zero.error ?? null,
      data: zero.data,
      dataUpdatedAt: zero.dataUpdatedAt,
    },
  };
  const sources = useDetailSources(countersPageDefinition.sources, inputs);

  return (
    <DetailPage
      definition={countersPageDefinition}
      payload={zero.data ?? null}
      sources={sources}
      onBack={() => void navigate({ to: "/pulse" })}
      onRetry={() => zero.refetch()}
      {...(deltas !== undefined ? { deltas } : {})}
      {...(sinceOpen !== undefined ? { deltaSinceOpen: sinceOpen } : {})}
      onResetDelta={reset}
    />
  );
}
