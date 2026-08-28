import { useMemo, useState } from "react";
import { formatNumber, useStrings } from "../../../i18n";
import type { Dict } from "../../../i18n";
import { Button } from "../../../ui/Button";
import { Chip } from "../../../ui/Chip";
import { Input } from "../../../ui/Input";
import { Toggle } from "../../../ui/Toggle";
import { describeField } from "../fieldCatalog";
import type { FieldLookupContext } from "../fieldCatalog";
import type { DynamicMapEntry, DynamicMapSectionInstance } from "../resolveSections";
import { FieldRow } from "./FieldRow";
import { SectionFrame } from "./SectionFrame";
import { EmptyNote, NodeList } from "./NodeTree";
import { buildValueNodes } from "./unknownFields";
import { isSectionExpanded, type DetailRenderContext } from "./context";

export interface DynamicMapSectionProps {
  instance: DynamicMapSectionInstance;
  ctx: DetailRenderContext;
  /**
   * Per-second deltas by entry path, when the page can compute them
   * (ruling R4: a client-side difference between consecutive polls). Task 7
   * plumbs the data; without it the delta control still exists and says
   * honestly that there is nothing to compare against yet.
   */
  deltas?: Record<string, number>;
  /**
   * Paths an explicitly declared section already renders. A map bound to a
   * whole subtree would otherwise show a nested array twice — once inside
   * its group, once as the BreakdownSection the page declared for it. The
   * explicit section wins (§12: configured sections come first).
   */
  hiddenNestedPaths?: ReadonlySet<string>;
}

interface VisibleGroup {
  id: string;
  title: string;
  entries: DynamicMapEntry[];
  nestedNodes: ReturnType<typeof buildValueNodes>;
  total: number;
  matched: number;
}

// matchesQuery searches BOTH the verbatim key and the resolved description
// (§9.7: "поиск по key и description"). Searching only the key would make a
// counter findable only by someone who already knows Telemt's name for it,
// which is the opposite of what the search is for.
function matchesQuery(
  entry: DynamicMapEntry,
  query: string,
  s: Dict,
  lookup: FieldLookupContext,
): boolean {
  if (query === "") return true;
  if (entry.key.toLowerCase().includes(query)) return true;
  return describeField(entry.path, s, lookup).description.toLowerCase().includes(query);
}

function isZero(value: unknown): boolean {
  return value === 0 || value === null || value === undefined || value === false;
}

// DynamicMapSection is §9.7/§11.2: forward-compatible counters and maps
// whose keys we have never seen. The KEY IS DATA — it is printed verbatim,
// never translated and never renamed — and the description comes from the
// catalog's counters-family fallback when no exact entry exists.
//
// The three controls the spec makes mandatory (grouping, search over key
// and description, a zero/non-zero filter) live here rather than on the
// page, because a page may carry more than one map. `Раскрыть все` /
// `Свернуть все` mirror the prototype's counters screen.
export function DynamicMapSection({
  instance,
  ctx,
  deltas,
  hiddenNestedPaths,
}: DynamicMapSectionProps) {
  const s = useStrings();
  const [query, setQuery] = useState("");
  const [nonZeroOnly, setNonZeroOnly] = useState(false);
  const [showDelta, setShowDelta] = useState(false);

  const q = query.trim().toLowerCase();

  const groups = useMemo<VisibleGroup[]>(
    () =>
      instance.groups.map((group) => {
        const entries = group.entries.filter(
          (e) => matchesQuery(e, q, s, ctx.lookup) && (!nonZeroOnly || !isZero(e.value)),
        );
        return {
          id: group.id,
          title: group.title?.(s) ?? group.id,
          entries,
          nestedNodes: group.nested
            .filter((n) => !(hiddenNestedPaths?.has(n.path) ?? false))
            .flatMap((n) => buildValueNodes(n.value, n.path)),
          total: group.entries.reduce(
            (sum, e) => (typeof e.value === "number" ? sum + e.value : sum),
            0,
          ),
          matched: entries.length,
        };
      }),
    [instance.groups, q, nonZeroOnly, s, ctx.lookup, hiddenNestedPaths],
  );

  const visible = groups.filter((g) => g.matched > 0 || g.nestedNodes.length > 0);
  const expanded = isSectionExpanded(instance.id, instance.defaultExpanded, ctx.expandedSections);

  return (
    <SectionFrame
      id={instance.id}
      title={instance.title(s)}
      description={instance.description?.(s)}
      count={instance.groups.reduce((n, g) => n + g.entries.length, 0)}
      expanded={expanded}
      onToggle={() => ctx.toggleSection(instance.id)}
    >
      <div className="flex flex-col gap-3 py-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={s.details.map.searchPlaceholder}
          aria-label={s.details.map.searchLabel}
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-11 items-center gap-2 text-meta text-text-muted">
            <Toggle
              checked={nonZeroOnly}
              onChange={setNonZeroOnly}
              aria-label={s.details.map.nonZeroOnly}
            />
            {s.details.map.nonZeroOnly}
          </label>
          {instance.supportsDelta && (
            <Chip active={showDelta} onClick={() => setShowDelta((v) => !v)}>
              {s.details.map.deltaMode}
            </Chip>
          )}
        </div>
        {showDelta && deltas === undefined && (
          <p className="text-micro text-text-faint">{s.details.map.deltaUnavailable}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => groups.forEach((g) => setGroupExpanded(ctx, `${instance.id}.${g.id}`, true))}
          >
            {s.details.map.expandAll}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => groups.forEach((g) => setGroupExpanded(ctx, `${instance.id}.${g.id}`, false))}
          >
            {s.details.map.collapseAll}
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyNote text={s.details.map.noMatches} />
      ) : (
        <div className="flex flex-col gap-2 pb-2">
          {visible.map((group) => (
            <SectionFrame
              nested
              key={group.id}
              id={`${instance.id}.${group.id}`}
              title={group.title}
              count={group.matched}
              trailing={<span className="tabular-nums">Σ {formatNumber(s, group.total)}</span>}
              expanded={isSectionExpanded(
                `${instance.id}.${group.id}`,
                true,
                ctx.expandedRecords,
              )}
              onToggle={() => ctx.toggleRecord(`${instance.id}.${group.id}`)}
            >
              {group.entries.map((entry) => (
                <FieldRow
                  key={entry.path}
                  path={entry.path}
                  value={entry.value}
                  present
                  ctx={ctx}
                  label={entry.key}
                  {...(showDelta && deltas?.[entry.path] !== undefined
                    ? { valueNote: `${formatDelta(deltas[entry.path] as number)}${s.details.value.perSecond}` }
                    : {})}
                />
              ))}
              {group.nestedNodes.length > 0 && <NodeList nodes={group.nestedNodes} ctx={ctx} />}
            </SectionFrame>
          ))}
        </div>
      )}
    </SectionFrame>
  );
}

function formatDelta(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

// setGroupExpanded drives the same "differs from default" encoding
// isSectionExpanded reads, so «Раскрыть все» is a no-op on groups that are
// already open instead of closing them.
function setGroupExpanded(ctx: DetailRenderContext, id: string, expanded: boolean): void {
  const current = isSectionExpanded(id, true, ctx.expandedRecords);
  if (current !== expanded) ctx.toggleRecord(id);
}
