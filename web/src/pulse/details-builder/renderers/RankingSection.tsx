import { useMemo, useState } from "react";
import { fill, useStrings } from "../../../i18n";
import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/Button";
import { Chip } from "../../../ui/Chip";
import { Input } from "../../../ui/Input";
import { Select } from "../../../ui/Select";
import { IconChevronRight } from "../../../ui/icons";
import { formatValue } from "../formatting";
import type { RankingSectionDefinition } from "../model";
import { indexPath } from "../paths";
import type { ClassifyContext, CollectionSectionInstance } from "../resolveSections";
import { AdaptiveDetailSurface } from "../surfaces/AdaptiveDetailSurface";
import { SectionFrame } from "./SectionFrame";
import { EmptyNote, NodeList, RevealMore } from "./NodeTree";
import { buildRecordNodes } from "./unknownFields";
import {
  applyFrozenOrder,
  applyRankingFilters,
  matchesRankingSearch,
  numericColumns,
  sortRanked,
  SCORE_SORT_KEY,
  type RankedEntry,
} from "./ranking.helpers";
import { isSectionExpanded, type DetailRenderContext } from "./context";

export interface RankingSectionProps {
  instance: CollectionSectionInstance;
  /** Owns identity/score/meta and the domain-relevant filters (§9.6, §18.2). */
  definition?: RankingSectionDefinition<unknown, unknown>;
  ctx: DetailRenderContext;
}

// RankingSection is §9.6: TLS fingerprints and connection leaders as a
// ranked list — rank number, identity, one meta line, the score, and a row
// that opens EVERY remaining field in the adaptive surface.
//
// Its own search and sort are section-local rather than page-level on
// purpose: Security carries FOUR rankings on one page (§23.3) and a single
// page-wide query would filter all of them at once. Filters are the
// opposite case and live in page state, because §18.2's summary shortcut
// has to be able to write the very filter the section's own chip toggles.
//
// The §19.2 rule this renderer exists to honour: while the reader is
// working with the list — typing in the search box, reading an open
// surface, or having just chosen a sort — a realtime frame MUST NOT
// reshuffle the rows under their finger. `frozenOrder` below is that
// promise; it re-syncs on the reader's next explicit action, or as soon as
// they are done.
export function RankingSection({ instance, definition, ctx }: RankingSectionProps) {
  const s = useStrings();
  const expanded = isSectionExpanded(instance.id, instance.defaultExpanded, ctx.expandedSections);
  const classifyCtx: ClassifyContext = {
    ...(ctx.lookup.catalog !== undefined ? { catalog: ctx.lookup.catalog } : {}),
    ...(ctx.lookup.endpoint !== undefined ? { endpoint: ctx.lookup.endpoint } : {}),
  };

  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);

  const entries = useMemo<RankedEntry[]>(
    () =>
      instance.items.map((item, index) => ({
        item,
        index,
        key: instance.itemKeys[index] ?? String(index),
        identity: definition?.identity?.(item) ?? instance.itemKeys[index] ?? String(index),
        meta: definition?.meta?.(item) ?? null,
        score: definition?.score?.(item) ?? 0,
      })),
    [instance.items, instance.itemKeys, definition],
  );

  const columns = useMemo(() => numericColumns(instance.items), [instance.items]);
  const scoreKey =
    definition?.scoreKey !== undefined && columns.includes(definition.scoreKey)
      ? definition.scoreKey
      : SCORE_SORT_KEY;
  // The sort slot is page state and carries the section it belongs to, so a
  // sort chosen on one ranking never silently reorders its neighbour.
  const sort = ctx.sort?.sectionId === instance.id ? ctx.sort : undefined;
  const sortKey = sort?.key ?? scoreKey;

  const ranked = useMemo(() => {
    const filtered = applyRankingFilters(entries, definition?.filters, ctx.filters).filter((e) =>
      matchesRankingSearch(e, query.trim(), definition?.search?.terms),
    );
    return sortRanked(filtered, sort ?? { key: scoreKey, direction: "desc" });
  }, [entries, definition, ctx.filters, query, sort, scoreKey]);

  // --- §19.2 frozen order -------------------------------------------------
  const surfaceEntry = entries.find((e) => e.key === ctx.openSurfaceKey);
  const interacting = searchFocused || query.trim() !== "" || surfaceEntry !== undefined || sort !== undefined;
  const [resyncToken, setResyncToken] = useState(0);
  const resync = () => setResyncToken((n) => n + 1);
  const ordered = useFrozenOrder(ranked, interacting, resyncToken);
  const drifted = interacting && ordered.some((entry, i) => ranked[i]?.key !== entry.key);

  const limit = ctx.visibleLimit(instance.id, instance.paging.initial);
  const shown = ordered.slice(0, limit);

  // §10.5 makes a search box mandatory above 21 elements; a ranking offers
  // one from the second element on, because "find this fingerprint" is the
  // question a ranking exists to answer.
  const searchRequired = instance.searchRequired || entries.length > 1;

  return (
    <SectionFrame
      id={instance.id}
      title={instance.title(s)}
      description={instance.description?.(s)}
      {...(instance.presence === "absent" ? {} : { count: entries.length })}
      expanded={expanded}
      onToggle={() => ctx.toggleSection(instance.id)}
    >
      {instance.presence === "absent" ? (
        <EmptyNote text={s.details.collection.absentTitle} />
      ) : instance.presence === "empty" ? (
        <EmptyNote text={s.details.collection.emptyTitle} />
      ) : (
        <>
          <div className="flex flex-col gap-3 py-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              {searchRequired && (
                <Input
                  type="search"
                  className="sm:flex-1"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    resync();
                  }}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  placeholder={s.details.ranking.searchPlaceholder}
                  aria-label={s.details.ranking.searchLabel}
                />
              )}
              {columns.length > 0 && (
                <Select
                  className="sm:w-56"
                  aria-label={s.details.ranking.sortLabel}
                  value={sortKey}
                  onChange={(e) => {
                    ctx.setSort({
                      key: e.target.value,
                      direction: "desc",
                      sectionId: instance.id,
                    });
                    resync();
                  }}
                >
                  {scoreKey === SCORE_SORT_KEY && (
                    <option value={SCORE_SORT_KEY}>{s.details.ranking.byScore}</option>
                  )}
                  {columns.map((column) => (
                    <option key={column} value={column}>
                      {fill(s.details.ranking.sortByTemplate, { column })}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            {definition?.filters && definition.filters.length > 0 && (
              // §18.2: the ordinary control STAYS next to the summary
              // shortcut. Both write the same page-state key, so a tile
              // press lights this chip up and pressing the chip clears it.
              <div className="flex flex-wrap gap-2">
                {definition.filters.map((filter) => {
                  const active = Object.hasOwn(ctx.filters, filter.key) && ctx.filters[filter.key] !== false;
                  return (
                    <Chip
                      key={filter.key}
                      active={active}
                      onClick={() => {
                        ctx.setFilter(filter.key, active ? undefined : true);
                        resync();
                      }}
                    >
                      {filter.label(s)}
                    </Chip>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-micro tabular-nums text-text-faint">
                {fill(s.details.collection.shownTemplate, {
                  shown: String(shown.length),
                  total: String(ordered.length),
                })}
              </span>
              {drifted && (
                // The explicit user action that re-syncs a frozen order.
                // Without it a reader who leaves the search box focused
                // would never see the new ranking; with it, the choice is
                // theirs and never the payload's.
                <Button variant="secondary" size="sm" onClick={resync}>
                  {s.details.ranking.refreshOrder}
                </Button>
              )}
            </div>
          </div>

          {ordered.length === 0 ? (
            <EmptyNote text={s.details.ranking.noMatches} />
          ) : (
            <ol className="flex flex-col">
              {shown.map((entry, i) => (
                <RankingRow
                  key={entry.key}
                  rank={i + 1}
                  entry={entry}
                  ctx={ctx}
                  {...(definition?.scoreLabel ? { scoreLabel: definition.scoreLabel(s) } : {})}
                  openLabel={s.details.entity.openDetails}
                  onOpen={() => ctx.openSurface(entry.key)}
                />
              ))}
            </ol>
          )}

          <RevealMore
            shown={shown.length}
            total={ordered.length}
            onReveal={() => {
              ctx.revealMore(instance.id, instance.paging.step, instance.paging.initial);
              resync();
            }}
            label={s.details.collection.showMore}
            countLabel={fill(s.details.collection.shownTemplate, {
              shown: String(shown.length),
              total: String(ordered.length),
            })}
          />
        </>
      )}

      <AdaptiveDetailSurface
        open={surfaceEntry !== undefined}
        onClose={ctx.closeSurface}
        title={surfaceEntry?.identity ?? ""}
        {...(surfaceEntry?.meta ? { subtitle: surfaceEntry.meta } : {})}
      >
        {surfaceEntry !== undefined && (
          <NodeList
            nodes={buildRecordNodes(
              surfaceEntry.item,
              indexPath(instance.path, surfaceEntry.index),
              classifyCtx,
            )}
            ctx={ctx}
          />
        )}
      </AdaptiveDetailSurface>
    </SectionFrame>
  );
}

interface OrderSnapshot {
  frozen: boolean;
  token: number;
  order: string[];
}

// useFrozenOrder holds the order captured when the reader started working
// and replays it over every later payload (§19.2).
//
// The snapshot is STATE adjusted during render (React's own "adjusting
// state when props change" pattern, the same one useDetailPageState uses
// for a page change) rather than a ref: the order is part of what this
// component renders, and a ref written during render is both a lint error
// and a real hazard — a payload that changed only the order would not
// repaint.
//
// Convergence: the snapshot is written only when the frozen flag flips, the
// resync token moves, or the replayed order genuinely differs from the
// stored one, so the extra render pass happens at most once per change and
// never loops.
function useFrozenOrder(
  ranked: readonly RankedEntry[],
  frozen: boolean,
  resyncToken: number,
): RankedEntry[] {
  const incoming = ranked.map((entry) => entry.key);
  const [snapshot, setSnapshot] = useState<OrderSnapshot>({
    frozen,
    token: resyncToken,
    order: incoming,
  });

  // A frame is replayed only while the freeze has been continuously on
  // since the last explicit action: the render that TURNS the freeze on
  // passes the current order through and captures it.
  const replaying = frozen && snapshot.frozen && snapshot.token === resyncToken;
  const order = replaying ? applyFrozenOrder(snapshot.order, incoming) : incoming;

  if (
    snapshot.frozen !== frozen ||
    snapshot.token !== resyncToken ||
    (frozen && !sameOrder(snapshot.order, order))
  ) {
    setSnapshot({ frozen, token: resyncToken, order });
  }

  const byKey = new Map(ranked.map((entry) => [entry.key, entry]));
  return order.flatMap((key) => {
    const entry = byKey.get(key);
    return entry ? [entry] : [];
  });
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

function RankingRow({
  rank,
  entry,
  ctx,
  scoreLabel,
  openLabel,
  onOpen,
}: {
  rank: number;
  entry: RankedEntry;
  ctx: DetailRenderContext;
  scoreLabel?: string;
  openLabel: string;
  onOpen: () => void;
}) {
  const s = useStrings();
  const score = formatValue(entry.score, s, { nowMs: ctx.nowMs, formatter: "integer" });
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${openLabel}: ${entry.identity}`}
        className={cn(
          "tap-target flex w-full items-center gap-3 border-b border-border py-2 text-left last:border-b-0",
          "hover:bg-surface-2",
        )}
      >
        <span className="w-6 shrink-0 text-center font-mono text-micro tabular-nums text-text-faint">
          {rank}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words font-mono text-[12.5px] font-semibold text-text">
            {entry.identity}
          </span>
          {entry.meta !== null && entry.meta !== "" && (
            <span className="block break-words text-meta text-text-muted">{entry.meta}</span>
          )}
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-row font-semibold tabular-nums text-text">{score.text}</span>
          {scoreLabel !== undefined && (
            <span className="block text-micro text-text-faint">{scoreLabel}</span>
          )}
        </span>
        <span className="shrink-0 text-text-faint" aria-hidden="true">
          <IconChevronRight />
        </span>
      </button>
    </li>
  );
}
