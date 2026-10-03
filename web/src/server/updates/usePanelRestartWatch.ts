import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getHealth, getUpdates } from "../../lib/api/generated/sdk.gen";
import { getUpdatesQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { UpdateRun } from "../../lib/api/generated/types.gen";
import { restartWatchDecision, type RestartWatchStatus } from "./restartWatch.helpers";

const HEALTH_POLL_MS = 2000;
const JOURNAL_POLL_MS = 3000;

export interface PanelRestartWatchResult {
  status: RestartWatchStatus;
  failure: UpdateRun | null;
  retry: () => void;
}

interface Watch {
  key: string;
  ticks: number;
  healthUpdatedAt: number;
  updatesUpdatedAt: number;
}

// Run-specific queries prevent an earlier run's cached probes or in-flight
// requests from confirming this restart. Cached responses for the same run
// must also be refreshed after activation before they affect the decision.
export function usePanelRestartWatch(active: boolean, runID: string, expectedVersion: string): PanelRestartWatchResult {
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: ["panel-restart-health", runID, expectedVersion],
    queryFn: async ({ signal }) => (await getHealth({ signal, throwOnError: true, cache: "no-store" })).data,
    enabled: active,
    retry: false,
    staleTime: 0,
    refetchInterval: active ? HEALTH_POLL_MS : false,
  });
  const updatesQuery = useQuery({
    queryKey: ["panel-restart-updates", runID, expectedVersion],
    queryFn: async ({ signal }) => (await getUpdates({ signal, throwOnError: true, cache: "no-store" })).data,
    enabled: active,
    retry: false,
    staleTime: 0,
    refetchInterval: active ? JOURNAL_POLL_MS : false,
  });
  const key = active ? `${runID}\0${expectedVersion}` : null;
  const [watch, setWatch] = useState<Watch | null>(null);
  if (watch?.key !== key && (watch !== null || key !== null)) {
    setWatch(key === null ? null : { key, ticks: 0, healthUpdatedAt: healthQuery.dataUpdatedAt, updatesUpdatedAt: updatesQuery.dataUpdatedAt });
  }

  useEffect(() => {
    if (key === null) return;
    const id = setInterval(() => setWatch((current) => current?.key === key ? { ...current, ticks: current.ticks + 1 } : current), HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [key]);

  const updatesFresh = watch?.key === key && updatesQuery.isSuccess && updatesQuery.dataUpdatedAt > watch.updatesUpdatedAt;
  useEffect(() => {
    if (updatesFresh) queryClient.setQueryData(getUpdatesQueryKey(), updatesQuery.data);
  }, [updatesFresh, updatesQuery.data, queryClient]);
  const journal = updatesFresh ? updatesQuery.data?.targets.find((target) => target.target === "panel")?.journal?.[0] ?? null : null;
  const healthFresh = watch?.key === key && healthQuery.isSuccess && healthQuery.dataUpdatedAt > watch.healthUpdatedAt;
  const status = active ? restartWatchDecision({
    runID, expectedVersion, health: healthQuery.data ?? null, healthFresh,
    elapsed: (watch?.ticks ?? 0) * HEALTH_POLL_MS, journal,
  }) : "wait";

  function retry() {
    if (key === null) return;
    setWatch({ key, ticks: 0, healthUpdatedAt: healthQuery.dataUpdatedAt, updatesUpdatedAt: updatesQuery.dataUpdatedAt });
    void healthQuery.refetch();
    void updatesQuery.refetch();
  }

  return { status, failure: status === "failed" ? journal : null, retry };
}
