import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getTelemtZeroOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import { useDisplayMode, visibleFor } from "../../display-mode";
import { Card } from "../../ui/Card";
import { Input } from "../../ui/Input";
import { IconSearch } from "../../ui/icons";
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
    // Not an error — the operator simply hasn't asked for this much
    // detail — so it renders as the dimmed informational card the
    // prototype uses for an unavailable section, not as a warning box.
    body = (
      <Card className="opacity-90">
        <p className="text-[13px] font-semibold text-text-muted">{ru.diag.extendedOnlyTitle}</p>
        <p className="mt-1 text-meta leading-relaxed text-text-muted">
          {ru.diag.extendedOnlyDescription}
        </p>
      </Card>
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
        <div className="relative">
          <IconSearch
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-faint"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ru.diag.searchPlaceholder}
            inputMode="search"
            className="pl-10"
          />
        </div>
        {groups.length === 0 && query.trim() !== "" ? (
          <p className="text-meta text-text-muted">{ru.diag.noResults}</p>
        ) : (
          <KVGroupList groups={groups} />
        )}
      </div>
    );
  }

  return <DiagShell title={ru.diag.domains.counters}>{body}</DiagShell>;
}
