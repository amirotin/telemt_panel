import { useMemo } from "react";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { ErrorState } from "../../ui/ErrorState";
import { Skeleton } from "../../ui/Skeleton";
import { useDisplayMode } from "../../display-mode";
import { useNow } from "../../people/useNow";
import type { GateHintKey } from "../../caps";
import { AttentionSummary } from "./AttentionSummary";
import { DetailHeader } from "./DetailHeader";
import { SummaryGrid } from "./SummaryGrid";
import type { FieldCatalog } from "./fieldCatalog";
import type { DetailPageDefinition, SectionDefinition } from "./model";
import { readPath } from "./paths";
import { resolveSections } from "./resolveSections";
import { sectionsForTab, withUnknownTail } from "./DetailPage.helpers";
import { createRenderContext } from "./renderers/context";
import { SectionList } from "./renderers/SectionList";
import type { PageSourcesState } from "./sources";
import { sourceStatusShortLabel } from "./sources";
import { selectEntity, useDetailPageState } from "./state";

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
  disabledHints?: Record<string, GateHintKey>;
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
  disabledHints,
}: DetailPageProps<TPayload, TContext>) {
  const s = useStrings();
  const { mode } = useDisplayMode();
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
  });

  const tabs = definition.navigation?.tabs;
  const activeTab = api.state.activeTab ?? tabs?.[0]?.id;
  const sections = resolved === null ? [] : withUnknownTail(resolved.sections, resolved.unknownFields);
  const shown = tabs ? sectionsForTab(sections, tabs, activeTab) : sections;

  const header = (
    <DetailHeader
      title={definition.title(s)}
      {...(definition.description ? { description: definition.description(s) } : {})}
      {...(breadcrumb !== undefined ? { breadcrumb } : {})}
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

  return (
    <div className="flex flex-col gap-4">
      {header}

      {definition.summary && definition.summary.length > 0 && (
        <SummaryGrid
          metrics={definition.summary}
          context={context}
          mode={mode}
          nowMs={clock}
          onFilter={api.setFilter}
          lookup={ctx.lookup}
        />
      )}

      {entities && items.length > 0 && (
        <EntitySelector
          labels={items.map((item) => entities.label(item))}
          keys={keys}
          activeKey={selection.status === "gone" ? undefined : activeKey}
          onSelect={api.selectEntityKey}
        />
      )}

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

      {tabs && tabs.length > 1 && (
        <SectionTabs
          tabs={tabs.map((tab) => ({ id: tab.id, label: tab.label(s) }))}
          activeId={activeTab}
          onSelect={api.setActiveTab}
        />
      )}

      {selection.status !== "gone" && (
        <SectionList
          sections={shown}
          definitions={sectionDefinitions}
          ctx={ctx}
          searchQuery={api.state.searchQuery}
          onSearchChange={api.setSearchQuery}
          raw={context}
          {...(deltas !== undefined ? { deltas } : {})}
        />
      )}
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

// EntitySelector is §15.2's horizontal strip with scroll snap. Task 5 adds
// the bounded swipe and the mandatory visible pager; the buttons here are
// already the non-gesture path §16.1 requires.
function EntitySelector({
  labels,
  keys,
  activeKey,
  onSelect,
}: {
  labels: string[];
  keys: string[];
  activeKey: string | undefined;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1">
      {keys.map((key, i) => (
        <button
          key={key}
          type="button"
          aria-pressed={key === activeKey}
          onClick={() => onSelect(key)}
          className={cn(
            "tap-target shrink-0 snap-start rounded-xl px-3 py-2 text-left font-mono text-[12.5px] font-semibold",
            key === activeKey
              ? "bg-surface-2 text-text ring-1 ring-accent"
              : "bg-surface text-text-muted hover:bg-surface-2",
          )}
        >
          {labels[i]}
        </button>
      ))}
    </div>
  );
}

// SectionTabs is the sticky segmented control of §15.2, wired as a real
// tablist so the keyboard and screen-reader contract of §21 holds.
function SectionTabs({
  tabs,
  activeId,
  onSelect,
}: {
  tabs: { id: string; label: string }[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div role="tablist" className="-mx-4 flex gap-2 overflow-x-auto px-4">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === activeId}
          onClick={() => onSelect(tab.id)}
          className={cn(
            "tap-target shrink-0 rounded-lg px-3 text-meta font-semibold",
            tab.id === activeId ? "bg-surface-2 text-text" : "text-text-muted hover:text-text",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
