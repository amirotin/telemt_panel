import { useMemo, useState } from "react";
import { fill, useStrings } from "../../../i18n";
import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/Button";
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
import {
  isSectionExpanded,
  type DetailRenderContext,
  type SectionAction,
  type SectionActionScope,
} from "./context";

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

  // What an action is allowed to claim it acts on. `narrowed` is the whole
  // point: the search box and the group chips are CLIENT-side narrowings
  // that no server-side filter selector can express, so a page handed the
  // filters alone would act on a superset of what is on screen.
  const actionScope = useMemo<SectionActionScope>(
    () => ({
      filters: ctx.filters,
      visibleKeys: filtered.map((entry) => entry.key),
      loadedCount: entries.length,
      narrowed: query !== "" || activeGroup !== null,
    }),
    [ctx.filters, filtered, entries.length, query, activeGroup],
  );

  const limit = ctx.visibleLimit(instance.id, instance.paging.initial);
  const shown = filtered.slice(0, limit);
  const open = entries.find((e) => e.key === ctx.openSurfaceKey);

  // §21: the rows are ONE tab stop with arrow-key movement inside it —
  // forty-seven writers must not be forty-seven stops between the search
  // box and the rest of the page.
  const roving = useRovingFocus({ count: shown.length, orientation: "vertical" });

  // A filter renders as a SELECT when it has a value set — declared, or
  // derived from the rows on screen — and as a chip when it is a plain
  // on/off predicate.
  const items = useMemo(() => entries.map((entry) => entry.item), [entries]);
  const chipFilters = (definition?.filters ?? []).filter(
    (f) => f.options === undefined && f.optionsFrom === undefined,
  );
  const selectFilters = (definition?.filters ?? [])
    .map((filter) => ({
      filter,
      options: filter.options ?? filter.optionsFrom?.(items) ?? [],
    }))
    .filter((entry) => entry.options.length > 0);

  // Page-supplied extensions (§SectionExtras): a bounded mutation offered
  // beside the rows it acts on, and SERVER-side paging for a cursor-paged
  // collection. `continuation` is offered only once every loaded row is on
  // screen, so the local reveal and the next request are never two buttons
  // competing for the same tap.
  const extras = ctx.extrasFor?.(instance.id);
  const continuation = extras?.continuation;
  const showContinuation =
    continuation !== undefined && continuation.hasMore && shown.length >= filtered.length;

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
              {selectFilters.map(({ filter, options }) => (
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
                  {options.map((option) => (
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

          {extras?.actions !== undefined && extras.actions.length > 0 && (
            <SectionActions actions={extras.actions} scope={actionScope} />
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
          {showContinuation && (
            <div className="flex items-center justify-between gap-3 py-2">
              <span className="text-micro tabular-nums text-text-faint">
                {fill(s.details.collection.shownTemplate, {
                  shown: String(shown.length),
                  total: `${filtered.length}+`,
                })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={continuation.pending}
                onClick={continuation.onLoad}
              >
                {continuation.label}
              </Button>
            </div>
          )}
        </>
      )}

      <AdaptiveDetailSurface
        open={open !== undefined}
        onClose={ctx.closeSurface}
        title={open?.identity ?? ""}
        {...(open?.status ? { subtitle: open.status } : {})}
      >
        {open !== undefined && (
          <>
            <NodeList
              nodes={buildRecordNodes(
                open.item,
                indexPath(instance.path, open.index),
                classifyCtx,
              )}
              ctx={ctx}
            />
            {extras?.entityAction !== undefined && (
              // The action sits at the FOOT of the surface, under the data
              // it acts on: a destructive control at the top would be the
              // first thing a thumb reaches on a phone.
              <div className="flex justify-end pt-3">
                <Button
                  variant={extras.entityAction.danger ? "danger" : "secondary"}
                  disabled={extras.entityAction.disabled ?? false}
                  onClick={() => extras.entityAction?.onSelect(open.key)}
                >
                  {extras.entityAction.label}
                </Button>
              </div>
            )}
          </>
        )}
      </AdaptiveDetailSurface>
    </SectionFrame>
  );
}

// SectionActions renders the head-of-body controls and the sentence that
// explains a disabled one.
//
// The `maxVisible` refusal lives HERE rather than in the page because the
// page cannot know the visible set until this component has computed it —
// and a control that silently widened its own request when the list got too
// long would be exactly the bug this scope contract exists to prevent.
function SectionActions({
  actions,
  scope,
}: {
  actions: readonly SectionAction[];
  scope: SectionActionScope;
}) {
  const resolved = actions.map((action) => {
    const overflowing =
      action.maxVisible !== undefined && scope.narrowed && scope.visibleKeys.length > action.maxVisible;
    const note = overflowing
      ? (action.tooManyNote?.(scope.visibleKeys.length, action.maxVisible ?? 0) ?? action.note)
      : (action.disabled ?? false)
        ? action.note
        : undefined;
    return { action, disabled: (action.disabled ?? false) || overflowing, note };
  });
  const notes = resolved.map((entry) => entry.note).filter((note): note is string => !!note);
  return (
    <div className="flex flex-col items-end gap-1 py-2">
      <div className="flex flex-wrap justify-end gap-2">
        {resolved.map(({ action, disabled }) => (
          <Button
            key={action.label}
            variant={action.danger ? "danger" : "secondary"}
            disabled={disabled}
            onClick={() => action.onSelect(scope)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {notes.map((note) => (
        <p key={note} className="text-right text-micro text-text-muted">
          {note}
        </p>
      ))}
    </div>
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
