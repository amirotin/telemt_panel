import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getTelemtZeroOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import { useDisplayMode, visibleFor } from "../../display-mode";
import { Input } from "../../ui/Input";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { ru, errorMessage } from "../../i18n/ru";
import { DiagShell } from "./DiagShell";
import { KVGroupList } from "./KVGroupList";
import { countersGroups } from "./counters.helpers";
import { filterGroups } from "./rows";

// CountersPage — the "Счётчики" domain: GET /v1/stats/zero/all via the
// panel's GET /api/telemt/zero (added for this task — see task-6-report.md's
// contract-gap note), fetched on visit rather than a topic (06-ui.md:
// extended-mode only, not a live SSE source), with a key-search filter.
export function CountersPage() {
  const { mode } = useDisplayMode();
  const [query, setQuery] = useState("");
  const extended = visibleFor("extended", mode);

  const zero = useQuery({ ...getTelemtZeroOptions(), enabled: extended });

  let body;
  if (!extended) {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
        <p className="text-sm font-medium text-text">{ru.diag.extendedOnlyTitle}</p>
        <p className="text-sm text-text-muted">{ru.diag.extendedOnlyDescription}</p>
      </div>
    );
  } else if (zero.isPending) {
    body = <Skeleton className="h-24 w-full" />;
  } else if (zero.isError) {
    body = (
      <ErrorState
        message={errorMessage(zero.error?.code ?? "internal_error")}
        onRetry={() => zero.refetch()}
      />
    );
  } else {
    const groups = filterGroups(countersGroups(zero.data), query);
    body = (
      <div className="flex flex-col gap-4">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ru.diag.searchPlaceholder}
          inputMode="search"
        />
        {groups.length === 0 && query.trim() !== "" ? (
          <p className="text-sm text-text-muted">{ru.diag.noResults}</p>
        ) : (
          <KVGroupList groups={groups} />
        )}
      </div>
    );
  }

  return <DiagShell title={ru.diag.domains.counters}>{body}</DiagShell>;
}
