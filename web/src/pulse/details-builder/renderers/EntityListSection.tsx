import { useMemo, useState } from "react";
import { fill, useStrings } from "../../../i18n";
import { cn } from "../../../lib/cn";
import { Chip } from "../../../ui/Chip";
import { Input } from "../../../ui/Input";
import { Select } from "../../../ui/Select";
import { IconChevronRight } from "../../../ui/icons";
import { describeField } from "../fieldCatalog";
import { formatValue } from "../formatting";
import type { EntityListSectionDefinition } from "../model";
import { childPath, indexPath, readPath } from "../paths";
import type { ClassifyContext, CollectionSectionInstance } from "../resolveSections";
import { AdaptiveDetailSurface } from "../surfaces/AdaptiveDetailSurface";
import { useRovingFocus, type RovingItemProps } from "../surfaces/rovingFocus";
import { SectionFrame } from "./SectionFrame";
import { EmptyNote, NodeList, RevealMore } from "./NodeTree";
import { buildRecordNodes } from "./unknownFields";
import {
  applyEntityFilters,
  groupsOf,
  matchesEntitySearch,
  orderByGroup,
  type EntityEntry,
} from "./entityList.helpers";
import { isSectionExpanded, type DetailRenderContext } from "./context";

export interface EntityListSectionProps {
  instance: CollectionSectionInstance;
  /** The declaring section, which owns identity/status/highlights (§9.3). */
  definition?: EntityListSectionDefinition<unknown, unknown>;
  ctx: DetailRenderContext;
  /** Page-level search box state (R3: in route memory, never in the URL). */
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
}

// EntityListSection is §9.3: one compact row per entity carrying identity,
// status and 1–3 headline values, with an explicit affordance that opens
// EVERY remaining field in the adaptive surface.
//
// The row is a real <button> (keyboard-openable, 44px tall), keyed by the
// definition's stable SEMANTIC key — §5.3/§19.2's reconciliation identity,
// never the array index — so a realtime frame that reorders the collection
// does not move the open surface onto a different entity.
//
// §23.2 adds grouping and filtering on top of that, for the forty-six ME
// writers: a chip row narrows the list to one data center, the declared
// filters narrow it by state, and the rows stay ONE collection underneath —
// one search, one paging window, one tab stop.
export function EntityListSection({
  instance,
  definition,
  ctx,
  searchQuery,
  onSearchChange,
}: EntityListSectionProps) {
  const s = useStrings();
  const expanded = isSectionExpanded(instance.id, instance.defaultExpanded, ctx.expandedSections);
  const classifyCtx: ClassifyContext = {
    ...(ctx.lookup.catalog !== undefined ? { catalog: ctx.lookup.catalog } : {}),
    ...(ctx.lookup.endpoint !== undefined ? { endpoint: ctx.lookup.endpoint } : {}),
  };

  // The selected group is view state of THIS section, like the ranking's own
  // search box: it survives a realtime frame and a rotation (nothing here is
  // remounted) and is deliberately not in the URL — R3 puts only the entity
  // and the tab there.
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

  const entries = useMemo<EntityEntry[]>(
    () =>
      instance.items.map((item, i) => ({
        item,
        index: i,
        key: instance.itemKeys[i] ?? String(i),
        identity: definition?.identity?.(item) ?? (instance.itemKeys[i] ?? String(i)),
        status: definition?.status?.(item) ?? null,
      })),
    [instance.items, instance.itemKeys, definition],
  );

  const group = definition?.groupBy;
  const groups = useMemo(() => groupsOf(entries, group, s), [entries, group, s]);

  const query = (searchQuery ?? "").trim();
  const filtered = useMemo(() => {
    const byFilter = applyEntityFilters(entries, definition?.filters, ctx.filters);
    const byQuery = byFilter.filter((entry) => matchesEntitySearch(entry, query));
    const byGroup =
      activeGroup === null || !group
        ? byQuery
        : byQuery.filter((entry) => group.key(entry.item) === activeGroup);
    return orderByGroup(byGroup, group, groups);
  }, [entries, definition, ctx.filters, query, activeGroup, group, groups]);

  const limit = ctx.visibleLimit(instance.id, instance.paging.initial);
  const shown = filtered.slice(0, limit);
  const open = entries.find((e) => e.key === ctx.openSurfaceKey);

  // §21: the rows are ONE tab stop with arrow-key movement inside it —
  // forty-seven writers must not be forty-seven stops between the search
  // box and the rest of the page.
  const roving = useRovingFocus({ count: shown.length, orientation: "vertical" });

  const chipFilters = (definition?.filters ?? []).filter((f) => f.options === undefined);
  const selectFilters = (definition?.filters ?? []).filter((f) => f.options !== undefined);

  return (
    <SectionFrame
      id={instance.id}
      title={instance.title(s)}
      description={instance.description?.(s)}
      {...(instance.presence === "absent" ? {} : { count: instance.items.length })}
      expanded={expanded}
      onToggle={() => ctx.toggleSection(instance.id)}
    >
      {instance.presence === "absent" ? (
        <EmptyNote text={s.details.collection.absentTitle} />
      ) : instance.presence === "empty" ? (
        <EmptyNote text={s.details.collection.emptyTitle} />
      ) : (
        <>
          {groups.length > 1 && (
            <div
              className="flex flex-wrap gap-2 py-2"
              role="group"
              aria-label={s.details.entity.groupLabel}
            >
              <Chip active={activeGroup === null} onClick={() => setActiveGroup(null)}>
                {`${s.details.entity.groupAll} · ${entries.length}`}
              </Chip>
              {groups.map((g) => (
                <Chip
                  key={g.id}
                  active={activeGroup === g.id}
                  onClick={() => setActiveGroup(activeGroup === g.id ? null : g.id)}
                >
                  {`${g.label} · ${g.count}`}
                </Chip>
              ))}
            </div>
          )}

          {(instance.searchRequired || selectFilters.length > 0) && (
            <div className="flex flex-col gap-2 py-2 sm:flex-row">
              {instance.searchRequired && onSearchChange && (
                <Input
                  type="search"
                  className="sm:flex-1"
                  value={searchQuery ?? ""}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder={s.details.entity.searchPlaceholder}
                  aria-label={s.details.entity.searchPlaceholder}
                />
              )}
              {selectFilters.map((filter) => (
                <Select
                  key={filter.key}
                  className="sm:w-52"
                  aria-label={filter.label(s)}
                  value={String(ctx.filters[filter.key] ?? "")}
                  onChange={(e) =>
                    ctx.setFilter(filter.key, e.target.value === "" ? undefined : e.target.value)
                  }
                >
                  {/* Every option carries the filter's NAME, not just its
                      value: a closed native select shows only the chosen
                      option, so «admission» alone stopped saying what it
                      was filtering the moment a reader picked it. */}
                  <option value="">{`${filter.label(s)}: ${s.details.entity.filterAny}`}</option>
                  {(filter.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {`${filter.label(s)}: ${option.label(s)}`}
                    </option>
                  ))}
                </Select>
              ))}
            </div>
          )}

          {chipFilters.length > 0 && (
            // §18.2: the ordinary control stays beside the summary shortcut.
            // Both write the same page-state key, so a tile press lights this
            // chip up and pressing the chip clears it.
            <div className="flex flex-wrap gap-2 pb-2">
              {chipFilters.map((filter) => {
                const active =
                  Object.hasOwn(ctx.filters, filter.key) && ctx.filters[filter.key] !== false;
                return (
                  <Chip
                    key={filter.key}
                    active={active}
                    onClick={() => ctx.setFilter(filter.key, active ? undefined : true)}
                  >
                    {filter.label(s)}
                  </Chip>
                );
              })}
            </div>
          )}

          {filtered.length === 0 ? (
            <EmptyNote text={s.details.entity.noMatches} />
          ) : (
            <div onKeyDown={roving.onKeyDown}>
              {shown.map((entry, i) => (
                <EntityBlock
                  key={entry.key}
                  heading={
                    group !== undefined && activeGroup === null && isGroupHead(shown, i, group)
                      ? (groups.find((g) => g.id === group.key(entry.item))?.label ?? null)
                      : null
                  }
                >
                  <EntityRow
                    rowProps={roving.itemProps(i)}
                    identity={entry.identity}
                    status={entry.status}
                    highlights={(definition?.highlights ?? []).map((path) => {
                      const value = readPath(entry.item, path);
                      const field = describeField(childPath(instance.path, path), s, ctx.lookup);
                      return formatValue(value, s, {
                        nowMs: ctx.nowMs,
                        ...(field.format !== undefined ? { formatter: field.format } : {}),
                        ...(field.unit !== undefined ? { unit: field.unit } : {}),
                      }).text;
                    })}
                    onOpen={() => ctx.openSurface(entry.key)}
                    openLabel={s.details.entity.openDetails}
                  />
                </EntityBlock>
              ))}
            </div>
          )}
          <RevealMore
            shown={shown.length}
            total={filtered.length}
            onReveal={() =>
              ctx.revealMore(instance.id, instance.paging.step, instance.paging.initial)
            }
            label={s.details.collection.showMore}
            countLabel={fill(s.details.collection.shownTemplate, {
              shown: String(shown.length),
              total: String(filtered.length),
            })}
          />
        </>
      )}

      <AdaptiveDetailSurface
        open={open !== undefined}
        onClose={ctx.closeSurface}
        title={open?.identity ?? ""}
        {...(open?.status ? { subtitle: open.status } : {})}
      >
        {open !== undefined && (
          <NodeList
            nodes={buildRecordNodes(
              open.item,
              indexPath(instance.path, open.index),
              classifyCtx,
            )}
            ctx={ctx}
          />
        )}
      </AdaptiveDetailSurface>
    </SectionFrame>
  );
}

// isGroupHead marks the row that starts a new group in the already-ordered
// list. Reading it off the RENDERED slice (rather than off the group table)
// is what keeps the headings correct when the paging window cuts a group in
// half: the next reveal simply continues without repeating the heading.
function isGroupHead(
  shown: readonly EntityEntry[],
  index: number,
  group: { key: (item: unknown) => string },
): boolean {
  if (index === 0) return true;
  const previous = shown[index - 1];
  return previous === undefined || group.key(previous.item) !== group.key(shown[index].item);
}

function EntityBlock({
  heading,
  children,
}: {
  heading: string | null;
  children: React.ReactNode;
}) {
  if (heading === null) return <>{children}</>;
  return (
    <>
      <p className="pt-3 pb-1 font-mono text-micro font-semibold uppercase text-text-faint">
        {heading}
      </p>
      {children}
    </>
  );
}

function EntityRow({
  identity,
  status,
  highlights,
  onOpen,
  openLabel,
  rowProps,
}: {
  identity: string;
  status: string | null;
  highlights: string[];
  onOpen: () => void;
  openLabel: string;
  /** Roving-tabindex membership (§21) — supplied by the section. */
  rowProps: RovingItemProps;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${openLabel}: ${identity}`}
      {...rowProps}
      className={cn(
        "tap-target flex w-full items-center gap-2 border-b border-border py-2 text-left last:border-b-0",
        "hover:bg-surface-2",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block break-words font-mono text-[12.5px] font-semibold text-text">
          {identity}
        </span>
        {status !== null && status !== "" && (
          <span className="block break-words text-meta text-text-muted">{status}</span>
        )}
      </span>
      {highlights.map((text, i) => (
        <span
          key={i}
          className="shrink-0 text-micro tabular-nums text-text-muted"
        >
          {text}
        </span>
      ))}
      <span className="shrink-0 text-text-faint" aria-hidden="true">
        <IconChevronRight />
      </span>
    </button>
  );
}
