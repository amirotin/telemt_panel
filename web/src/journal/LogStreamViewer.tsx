import { useMemo, useReducer, useState } from "react";
import { pluralTemplate, useStrings } from "../i18n";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { StatePill } from "../ui/StatePill";
import { useDisplayMode, visibleFor } from "../display-mode";
import { useDebouncedValue } from "../people/useDebouncedValue";
import { createJournalState, journalReducer, pendingCount } from "./logRing";
import { filterLogLines } from "./logFilter.helpers";
import { useDefaultLevels } from "./useDefaultLevels";
import { useLogStream } from "./useLogStream";
import { LogToolbar } from "./LogToolbar";
import { LogList } from "./LogList";
import type { LogicalService } from "./types";

export interface LogStreamViewerProps {
  service: LogicalService;
  onServiceChange: (service: LogicalService) => void;
}

// LogStreamViewer — the live-tail half of the Logs tab (caps.log_stream ===
// true). LogsTab mounts this with `key={service}`, so a source switch fully
// resets the ring/pause reducer and forces useLogStream's effect to
// close the old EventSource and open a new one (Task 7 brief B) — simpler
// and more obviously correct than threading an explicit reset action
// through the reducer for the same effect.
export function LogStreamViewer({
  service,
  onServiceChange,
}: LogStreamViewerProps) {
  const s = useStrings();
  const { mode } = useDisplayMode();
  const [state, dispatch] = useReducer(
    journalReducer,
    undefined,
    createJournalState,
  );
  const [levels, setLevels] = useDefaultLevels(mode);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);

  const streamState = useLogStream(service, (line) =>
    dispatch({ type: "line", line }),
  );

  const filtered = useMemo(
    () => filterLogLines(state.lines, levels, debouncedSearch),
    [state.lines, levels, debouncedSearch],
  );

  const pending = pendingCount(state);
  // Only reserve a row for the stream-status pills when there is actually
  // something to say; an always-present empty flex row left a visible gap
  // above the feed in the healthy case.
  const hasStreamNotice =
    streamState.status === "reconnecting" ||
    streamState.status === "closed" ||
    streamState.stale;

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
        paused={state.paused}
        onTogglePause={() =>
          dispatch({ type: state.paused ? "resume" : "pause" })
        }
        onClear={() => dispatch({ type: "clear" })}
      />

      {hasStreamNotice && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {streamState.status === "reconnecting" && (
            <StatePill state="warn">{s.journal.reconnecting}</StatePill>
          )}
          {streamState.stale && streamState.status !== "reconnecting" && (
            <StatePill state="warn">{s.common.stale}</StatePill>
          )}
          {streamState.status === "closed" && (
            <>
              <StatePill state="error">
                {s.journal.streamClosedTitle}
              </StatePill>
              <Button variant="secondary" size="sm" onClick={streamState.retry}>
                {s.journal.retryStream}
              </Button>
            </>
          )}
        </div>
      )}

      {/*
        The prototype's centered divider chip (its «сегодня» pill), reused
        here to announce the lines piling up behind a paused feed — a
        centered marker over the list rather than another status pill
        competing with the stream's own warn/error pills above it.
      */}
      {state.paused && pending > 0 && (
        <span className="self-center rounded-full bg-surface-2 px-3 py-1 text-micro font-semibold text-text-muted">
          {pluralTemplate(s, pending, s.journal.newLines)}
        </span>
      )}

      {state.lines.length === 0 ? (
        <EmptyState title={s.journal.emptyTitle} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={s.journal.emptyFilterTitle}
          description={s.journal.emptyFilterDescription}
        />
      ) : (
        <LogList lines={filtered} showUnit={visibleFor("extended", mode)} />
      )}
    </div>
  );
}
