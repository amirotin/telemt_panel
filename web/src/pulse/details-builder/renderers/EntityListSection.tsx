import { useMemo } from "react";
import { fill, useStrings } from "../../../i18n";
import { cn } from "../../../lib/cn";
import { Input } from "../../../ui/Input";
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

  const entries = useMemo(
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

  const query = (searchQuery ?? "").trim().toLowerCase();
  const filtered =
    query === ""
      ? entries
      : entries.filter(
          (e) =>
            e.identity.toLowerCase().includes(query) ||
            (e.status ?? "").toLowerCase().includes(query),
        );

  const limit = ctx.visibleLimit(instance.id, instance.paging.initial);
  const shown = filtered.slice(0, limit);
  const open = entries.find((e) => e.key === ctx.openSurfaceKey);

  // §21: the rows are ONE tab stop with arrow-key movement inside it —
  // forty-seven writers must not be forty-seven stops between the search
  // box and the rest of the page.
  const roving = useRovingFocus({ count: shown.length, orientation: "vertical" });

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
          {instance.searchRequired && onSearchChange && (
            <div className="py-2">
              <Input
                type="search"
                value={searchQuery ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={s.details.entity.searchPlaceholder}
                aria-label={s.details.entity.searchPlaceholder}
              />
            </div>
          )}
          {filtered.length === 0 ? (
            <EmptyNote text={s.details.entity.noMatches} />
          ) : (
            <div onKeyDown={roving.onKeyDown}>
              {shown.map((entry, i) => (
              <EntityRow
                key={entry.key}
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
