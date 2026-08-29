import { useCallback, useMemo } from "react";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { ErrorState } from "../../ui/ErrorState";
import { Skeleton } from "../../ui/Skeleton";
import { useDisplayMode } from "../../display-mode";
import { useNow } from "../../people/useNow";
import type { GateHintSpec } from "../../caps";
import { AttentionSummary } from "./AttentionSummary";
import { DetailHeader } from "./DetailHeader";
import { EntityPager, EntitySelector } from "./EntitySelector";
import { SectionTabs } from "./SectionTabs";
import { SummaryGrid } from "./SummaryGrid";
import type { FieldCatalog } from "./fieldCatalog";
import type { DetailPageDefinition, SectionDefinition, SummaryShortcut } from "./model";
import { readPath } from "./paths";
import { resolveSections } from "./resolveSections";
import { sectionsForTab, tabElementId, withUnknownTail } from "./DetailPage.helpers";
import { createRenderContext, type SectionExtras } from "./renderers/context";
import type { CustomSectionRegistry } from "./renderers/customRenderers";
import { SectionList } from "./renderers/SectionList";
import type { PageSourcesState } from "./sources";
import { sourceStatusShortLabel } from "./sources";
import { selectEntity, useDetailPageState } from "./state";
import { useBoundedSwipe } from "./surfaces/useBoundedSwipe";
import { isCompact, isSplitLayout, useLayoutMode } from "./surfaces/useLayoutMode";

// The header's age ticks faster than the rows do: "актуально 2 сек назад"
// is only useful if it moves, while re-rendering a 1900-leaf section list
// every second is not. The page therefore keeps ONE clock at the users-list
// cadence and lets DetailHeader own the fast one.
const PAGE_CLOCK_MS = 30_000;

export interface DetailPageProps<TPayload, TContext> {
  definition: DetailPageDefinition<TPayload, TContext>;
  /** The payload the sources produced; `null` while there is nothing to show. */
  payload: TPayload | null | undefined;
  sources: PageSourcesState;
  breadcrumb?: string;
  onBack?: () => void;
  onRetry?: () => void;
  catalog?: FieldCatalog;
  /** Which endpoint's catalog rules win for this page (R9). */
  endpoint?: string;
  /** Fixed clock — tests and the dev route pass one so output is deterministic. */
  nowMs?: number;
  /** Per-second counter deltas, keyed by normalized path (ruling R4). */
  deltas?: Record<string, number>;
  /** Absolute counter change since the page opened, by normalized path (R4). */
  deltaSinceOpen?: Record<string, number>;
  /** A Telemt restart zeroed the counters during this visit (R4). */
  deltaRestarted?: boolean;
  /** Moves the since-open delta baseline to the current snapshot (R4). */
  onResetDelta?: () => void;
  /** Domain chart renderers for this page's CustomSections (§9.8). */
  customRenderers?: CustomSectionRegistry;
  disabledHints?: Record<string, GateHintSpec>;
  /**
   * Live, section-scoped extensions the DEFINITION cannot express: a badge
   * read off the payload, server-side paging, a bounded mutation offered
   * beside the rows it acts on. Keyed by section id — see SectionExtras.
   */
  sectionExtras?: Record<string, SectionExtras>;
}

// DetailPage assembles §6's tree from a declarative definition: header,
// summary, entity selector, tabs, attention, sections, unknown tail. It
// owns no domain knowledge whatsoever — every page-specific decision lives
// in the definition (Tasks 6–8) or in the field catalog.
//
// Its two invariants come straight from §14 and §19.1: a degraded source
// never replaces the sections that still work, and nothing on screen holds
// a copy of the payload, so a realtime frame changes the DATA without
// touching a single piece of interaction state.
export function DetailPage<TPayload, TContext>({
  definition,
  payload,
  sources,
  breadcrumb,
  onBack,
  onRetry,
  catalog,
  endpoint,
  nowMs,
  deltas,
  deltaSinceOpen,
  deltaRestarted,
  onResetDelta,
  customRenderers,
  disabledHints,
  sectionExtras,
}: DetailPageProps<TPayload, TContext>) {
  const s = useStrings();
  const { mode } = useDisplayMode();
  // §15: the ONE viewport read on this page. Everything responsive below —
  // the compressed landscape header, the rail, the sticky master pane, the
  // sheet placement, whether the swipe is armed — is a function of it, and
  // NOTHING here is remounted when it changes, which is what makes §15.3's
  // "поворот не сбрасывает выбранную сущность, filters и expanded state"
  // true by construction rather than by an effect that restores state.
  const layout = useLayoutMode();
  const ticking = useNow(PAGE_CLOCK_MS);
  const clock = nowMs ?? ticking;
  const api = useDetailPageState({
    pageId: definition.id,
    ...(definition.initialState ? { initial: definition.initialState } : {}),
  });

  // --- entity selection (§5.3, §19.2) ------------------------------------
  const entities = definition.navigation?.entities;
  const items = useMemo<unknown[]>(() => {
    if (!entities || payload === null || payload === undefined) return [];
    const raw = entities.select ? entities.select(payload) : readPath(payload, entities.path);
    return Array.isArray(raw) ? raw : [];
  }, [entities, payload]);
  const keys = useMemo(
    () => (entities ? items.map((item, i) => entities.entityKey(item, i)) : []),
    [entities, items],
  );
  const selection = selectEntity(keys, api.state.selectedEntityKey);
  const activeKey =
    selection.status === "selected" ? selection.key : (selection.fallback ?? undefined);

  // --- entity paging: the pager and the swipe (§16.2) ---------------------
  const activeIndex = activeKey === undefined ? 0 : Math.max(keys.indexOf(activeKey), 0);
  const { selectEntityKey } = api;
  const step = useCallback(
    (delta: number) => {
      if (keys.length === 0) return;
      const next = keys[(activeIndex + delta + keys.length) % keys.length];
      if (next !== undefined) selectEntityKey(next);
    },
    [keys, activeIndex, selectEntityKey],
  );
  const swipe = useBoundedSwipe({
    onNext: () => step(1),
    onPrevious: () => step(-1),
    // §16.2 bounds the gesture to the hero of a touch layout. On a desktop
    // the pager buttons are the whole story.
    //
    // An open §17 surface disarms it entirely. Today every placement covers
    // the viewport, so a real finger reaches the backdrop rather than the
    // hero — but that is a property of the current sheet, not a guarantee:
    // the moment a docked placement without a backdrop appears (§15.4 allows
    // a sticky master pane), a swipe would page the entity underneath the
    // open card and leave the reader holding a record for something they can
    // no longer see.
    enabled: isCompact(layout) && keys.length > 1 && api.state.openSurfaceKey === undefined,
  });

  // --- context ------------------------------------------------------------
  const context = useMemo<TContext | null>(() => {
    if (payload === null || payload === undefined) return null;
    const nav = definition.navigation;
    if (nav?.selectEntity) return nav.selectEntity(payload, activeKey);
    if (definition.selectContext) return definition.selectContext(payload, api.state);
    return payload as unknown as TContext;
    // api.state is deliberately not a dependency: selectContext reads the
    // page state only to narrow the payload, and re-narrowing on every
    // filter keystroke is exactly the churn §19.1 asks us to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, payload, activeKey]);

  const resolved = useMemo(
    () =>
      context === null
        ? null
        : resolveSections({
            definition,
            context,
            ...(catalog !== undefined ? { catalog } : {}),
            ...(endpoint !== undefined ? { endpoint } : {}),
          }),
    [definition, context, catalog, endpoint],
  );

  const sectionDefinitions = useMemo(
    () =>
      new Map<string, SectionDefinition<unknown>>(
        definition.sections.map((section) => [
          section.id,
          section as unknown as SectionDefinition<unknown>,
        ]),
      ),
    [definition],
  );

  const ctx = createRenderContext(api, {
    nowMs: clock,
    mode,
    lookup: {
      ...(catalog !== undefined ? { catalog } : {}),
      ...(endpoint !== undefined ? { endpoint } : {}),
    },
    absenceFor: (sourceId) => {
      const state = sourceId === undefined ? undefined : sources.byId[sourceId];
      if (state === undefined) return undefined;
      if (state.status === "unsupported") return "unsupported";
      if (state.status === "error" || state.status === "disabled") return "unavailable";
      return undefined;
    },
    ...(sectionExtras !== undefined ? { sectionExtras } : {}),
  });

  // §18.2: a summary tile writes the SAME state slots the section's own
  // controls write. It cannot express anything a control cannot, which is
  // what keeps the ordinary control meaningful next to it.
  const applyShortcut = (shortcut: SummaryShortcut) => {
    if (shortcut.filter) api.setFilter(shortcut.filter.key, shortcut.filter.value);
    if (shortcut.sort) api.setSort(shortcut.sort);
  };

  const tabs = definition.navigation?.tabs;
  const activeTab = api.state.activeTab ?? tabs?.[0]?.id;
  const sections = resolved === null ? [] : withUnknownTail(resolved.sections, resolved.unknownFields);
  const shown = tabs ? sectionsForTab(sections, tabs, activeTab) : sections;

  const header = (
    <DetailHeader
      title={definition.title(s)}
      {...(definition.description ? { description: definition.description(s) } : {})}
      {...(breadcrumb !== undefined ? { breadcrumb } : {})}
      // §15.3: in compact landscape the lede and the secondary header text
      // give their pixels back to the content.
      compact={layout === "compact-landscape"}
      status={sources.status}
      freshnessMs={sources.freshnessMs}
      nowMs={clock}
      {...(onBack ? { onBack } : {})}
    />
  );

  const attention = (
    <AttentionSummary
      sources={sources}
      definitions={definition.sources}
      {...(disabledHints !== undefined ? { disabledHints } : {})}
    />
  );

  // §14: a page with no data yet says which of the eight states it is in;
  // it never shows a blank screen, and it never shows an error banner in
  // place of sections that do work.
  if (context === null) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        {attention}
        {sources.status === "loading" ? (
          <LoadingSkeleton />
        ) : sources.status === "error" ? (
          <ErrorState
            message={s.details.state.error}
            {...(onRetry ? { onRetry } : {})}
          />
        ) : (
          <EmptyState
            title={sourceStatusShortLabel(sources.status, s)}
            description={s.details.page.noData}
          />
        )}
      </div>
    );
  }

  const summary = definition.summary && definition.summary.length > 0 && (
    <SummaryGrid
      metrics={definition.summary}
      context={context}
      mode={mode}
      nowMs={clock}
      onShortcut={applyShortcut}
      lookup={ctx.lookup}
      // §15.3: "summary cards уплотняются без удаления critical values".
      dense={layout === "compact-landscape"}
    />
  );

  const pager = entities && keys.length > 1 && (
    <EntityPager
      index={activeIndex}
      total={keys.length}
      previousLabel={entities.label(items[(activeIndex - 1 + items.length) % items.length])}
      nextLabel={entities.label(items[(activeIndex + 1) % items.length])}
      onPrevious={() => step(-1)}
      onNext={() => step(1)}
    />
  );

  // The hero is the bounded region §16.2 allows the gesture on — the
  // summary plus the pager, never the page and never the horizontally
  // scrolling selector strip (a swipe there would fight its own scroll).
  // `touch-pan-y` keeps vertical scrolling native while the horizontal axis
  // is ours to read.
  const hero = (summary || pager) && (
    <div
      className="flex touch-pan-y flex-col gap-3"
      data-testid="detail-hero"
      onPointerDown={swipe.onPointerDown}
      onPointerMove={swipe.onPointerMove}
      onPointerUp={swipe.onPointerUp}
      onPointerCancel={swipe.onPointerCancel}
    >
      {summary}
      {pager}
    </div>
  );

  const panelId = `${definition.id}-sections`;
  const tabbed = tabs !== undefined && tabs.length > 1;

  return (
    <div className="flex flex-col gap-4">
      {header}

      {/* §15.3/§15.4's master + detail split, and §15.2's single column —
          ONE element tree in every mode. `display: contents` dissolves the
          split wrapper where there is no split, so a rotation changes CSS
          and nothing else: no section is remounted and nothing the reader
          typed, opened or filtered is lost. */}
      <div
        className={cn(isSplitLayout(layout) ? "flex flex-row items-start gap-4" : "contents")}
        data-layout={layout}
      >
        {entities && items.length > 0 && (
          <EntitySelector
            labels={items.map((item) => entities.label(item))}
            keys={keys}
            activeKey={selection.status === "gone" ? undefined : activeKey}
            onSelect={api.selectEntityKey}
            layout={layout}
            {...(entities.attention
              ? {
                  attention: items.map((item) => {
                    const mark = entities.attention?.(item) ?? null;
                    return mark === null ? null : { tone: mark.tone, reason: mark.reason(s) };
                  }),
                }
              : {})}
          />
        )}

        <div
          className={cn(
            "flex min-w-0 flex-col gap-4",
            isSplitLayout(layout) && "flex-1",
            // §15.4: the detail column stops at a readable measure instead
            // of stretching field descriptions across a 1920 px screen.
            layout === "wide" && "detail-readable",
          )}
        >
          {hero}

          {selection.status === "gone" && (
            <Card className="flex flex-col gap-2">
              <p className="text-sm font-semibold text-text">{s.details.entity.goneTitle}</p>
              <p className="text-meta text-text-muted">{s.details.entity.goneDescription}</p>
              {selection.fallback !== null && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onClick={() => api.selectEntityKey(selection.fallback ?? undefined)}
                >
                  {s.details.entity.goneFallback}
                </Button>
              )}
            </Card>
          )}

          {attention}

          {tabbed && (
            <SectionTabs
              tabs={tabs.map((tab) => {
                const count = tab.count?.(context);
                return {
                  id: tab.id,
                  label: tab.label(s),
                  ...(count !== undefined && count !== null ? { count } : {}),
                };
              })}
              activeId={activeTab}
              onSelect={api.setActiveTab}
              panelId={panelId}
              label={s.details.page.tabsLabel}
            />
          )}

          {/* The tabs' panel (§21). Always the same element, tabs or not,
              so switching layout or turning tabs on never remounts the
              section list underneath it. */}
          <div
            id={panelId}
            {...(tabbed
              ? {
                  role: "tabpanel",
                  ...(activeTab !== undefined
                    ? { "aria-labelledby": tabElementId(panelId, activeTab) }
                    : {}),
                }
              : {})}
          >
            {selection.status !== "gone" && (
              <SectionList
                sections={shown}
                definitions={sectionDefinitions}
                ctx={ctx}
                searchQuery={api.state.searchQuery}
                onSearchChange={api.setSearchQuery}
                raw={context}
                {...(deltas !== undefined ? { deltas } : {})}
                {...(deltaSinceOpen !== undefined ? { deltaSinceOpen } : {})}
                {...(deltaRestarted !== undefined ? { deltaRestarted } : {})}
                {...(onResetDelta !== undefined ? { onResetDelta } : {})}
                {...(customRenderers !== undefined ? { customRenderers } : {})}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}
