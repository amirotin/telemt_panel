import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tailLogsOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import { AsyncState } from "../components/AsyncState";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ru } from "../i18n/ru";
import { useDisplayMode, visibleFor } from "../display-mode";
import { useDebouncedValue } from "../people/useDebouncedValue";
import { filterLogLines } from "./logFilter.helpers";
import { useDefaultLevels } from "./useDefaultLevels";
import { LogToolbar } from "./LogToolbar";
import { LogList } from "./LogList";
import type { LogicalService } from "./types";
import type { RingLine } from "./logRing";

const TAIL_LINES = 500;

export interface LogTailFallbackProps {
  service: LogicalService;
  onServiceChange: (service: LogicalService) => void;
}

// LogTailFallback — Task 7 deliverable B's degraded path: caps.log_stream
// is false but caps.log_tail is true (e.g. a log source that can read a
// bounded window but can't follow it live). A button-triggered GET
// /api/logs/tail?service=&lines= stands in for the live feed; the same
// toolbar/level-filter/search/LogList are reused, minus pause (there's no
// live buffer to pause).
export function LogTailFallback({ service, onServiceChange }: LogTailFallbackProps) {
  const { mode } = useDisplayMode();
  const [levels, setLevels] = useDefaultLevels(mode);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);

  const query = useQuery({
    ...tailLogsOptions({ query: { service, lines: TAIL_LINES } }),
    enabled: false,
  });

  const ringLines = useMemo<RingLine[]>(
    () => (query.data ?? []).map((line, index) => ({ ...line, id: index })),
    [query.data],
  );
  const filtered = useMemo(
    () => filterLogLines(ringLines, levels, debouncedSearch),
    [ringLines, levels, debouncedSearch],
  );

  const hasLoadedOnce = query.data !== undefined || query.isFetching || query.isError;

  return (
    <div className="flex flex-col gap-3">
      <LogToolbar
        service={service}
        onServiceChange={onServiceChange}
        levels={levels}
        onLevelsChange={setLevels}
        mode={mode}
        search={search}
        onSearchChange={setSearch}
      />

      {!hasLoadedOnce ? (
        <EmptyState
          title={ru.journal.tailFallback.title}
          action={
            <Button onClick={() => void query.refetch()}>{ru.journal.tailFallback.loadButton}</Button>
          }
        />
      ) : (
        <>
          {query.data !== undefined && (
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => void query.refetch()} disabled={query.isFetching}>
                {ru.journal.tailFallback.loadMoreButton}
              </Button>
            </div>
          )}
          <AsyncState
            isPending={query.isFetching && query.data === undefined}
            isError={query.isError}
            errorCode={query.error?.code}
            data={query.data}
            onRetry={() => void query.refetch()}
            isEmpty={(d) => d.length === 0}
            emptyTitle={ru.journal.emptyTitle}
          >
            {() =>
              filtered.length === 0 ? (
                <EmptyState title={ru.journal.emptyFilterTitle} description={ru.journal.emptyFilterDescription} />
              ) : (
                <LogList lines={filtered} showUnit={visibleFor("extended", mode)} />
              )
            }
          </AsyncState>
        </>
      )}
    </div>
  );
}
