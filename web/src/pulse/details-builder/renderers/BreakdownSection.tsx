import { useMemo } from "react";
import { useStrings } from "../../../i18n";
import { formatNumber } from "../../../i18n";
import { formatValue } from "../formatting";
import type { BreakdownSectionDefinition } from "../model";
import type { CollectionSectionInstance } from "../resolveSections";
import {
  breakdownTotal,
  buildBreakdownRows,
  pickDelta,
  type BreakdownRow,
} from "./breakdown.helpers";
import { SectionFrame } from "./SectionFrame";
import { EmptyNote } from "./NodeTree";
import { isSectionExpanded, type DetailRenderContext } from "./context";

export interface BreakdownSectionProps {
  instance: CollectionSectionInstance;
  /** Owns the label/total/lifetime accessors when the pair is spelled unusually. */
  definition?: BreakdownSectionDefinition<unknown, unknown>;
  ctx: DetailRenderContext;
  /**
   * Per-second deltas by row path (ruling R4). Task 7 computes them from two
   * consecutive `/api/telemt/zero` answers; a row with no entry simply shows
   * no delta, which is the honest state before the second response.
   *
   * The key is the row's SEMANTIC path — `<section path>.<label>` — not its
   * index, so a reordered payload cannot move a delta onto another class.
   */
  deltas?: Record<string, number>;
}

// BreakdownSection is §9.4: `{class,total}` / `{stage,total}` pairs, ONE row
// per entity. The pair's two leaves never become two KV rows — that is the
// exact failure the donor `isClassTotalList` was written to avoid, and the
// reason a breakdown is a section kind of its own rather than an array.
//
// Each row carries its share of the section total as a horizontal bar plus
// the percentage, which is what makes a breakdown readable at a glance: the
// numbers alone answer "how many", the bar answers "how much of it".
//
// Rows are sorted descending with a stable tie-break on the label, so two
// classes with equal counters keep their places across realtime frames
// (§19.2's "не прыгать во время взаимодействия" applied to the simplest
// possible collection).
export function BreakdownSection({ instance, definition, ctx, deltas }: BreakdownSectionProps) {
  const s = useStrings();
  const expanded = isSectionExpanded(instance.id, instance.defaultExpanded, ctx.expandedSections);

  const rows = useMemo(
    () =>
      buildBreakdownRows(instance.items, {
        ...(definition?.label ? { label: definition.label } : {}),
        ...(definition?.total ? { total: definition.total } : {}),
      }),
    [instance.items, definition],
  );
  const sum = breakdownTotal(rows);
  const lifetime = definition?.lifetime;

  return (
    <SectionFrame
      id={instance.id}
      title={instance.title(s)}
      description={instance.description?.(s)}
      {...(instance.presence === "absent" ? {} : { count: rows.length })}
      {...(rows.length > 0
        ? { trailing: <span className="tabular-nums">Σ {formatNumber(s, sum)}</span> }
        : {})}
      expanded={expanded}
      onToggle={() => ctx.toggleSection(instance.id)}
    >
      {instance.presence === "absent" ? (
        <EmptyNote text={s.details.collection.absentTitle} />
      ) : instance.presence === "empty" ? (
        <EmptyNote text={s.details.collection.emptyTitle} />
      ) : rows.length === 0 ? (
        // The section is bound to a real collection whose elements are not
        // pairs. Saying so beats drawing a column of NaNs — and because the
        // resolver leaves such a subtree UNCONSUMED, the leaves really do
        // reappear in the unknown tail (§27.4), the way an unregistered
        // custom renderer falls back to the node tree.
        <EmptyNote text={s.details.breakdown.notPairs} />
      ) : (
        <div className="flex flex-col py-1">
          {rows.map((row) => (
            <BreakdownRowView
              key={row.key}
              row={row}
              ctx={ctx}
              {...(lifetime ? { lifetimeValue: lifetime(row.item) } : {})}
              {...deltaProp(deltas, instance.path, row.label)}
            />
          ))}
        </div>
      )}
    </SectionFrame>
  );
}

function deltaProp(
  deltas: Record<string, number> | undefined,
  path: string,
  label: string,
): { delta?: number } {
  const value = pickDelta(deltas, path, label);
  return value === undefined ? {} : { delta: value };
}

function BreakdownRowView({
  row,
  ctx,
  delta,
  lifetimeValue,
}: {
  row: BreakdownRow;
  ctx: DetailRenderContext;
  delta?: number;
  lifetimeValue?: number | null;
}) {
  const s = useStrings();
  const total = formatValue(row.total, s, { nowMs: ctx.nowMs, formatter: "integer" });
  const percent =
    row.percent === null
      ? null
      : formatValue(row.percent, s, { nowMs: ctx.nowMs, unit: "percent" }).text;

  return (
    <div className="border-b border-border py-2.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        {/* The class name is DATA (§11.2) — verbatim, monospace, never translated. */}
        <span className="min-w-0 break-words font-mono text-[12.5px] font-semibold text-text">
          {row.label}
        </span>
        <span className="shrink-0 text-right">
          <span className="text-row font-semibold tabular-nums text-text">{total.text}</span>
          {percent !== null && (
            <span className="ml-2 text-meta tabular-nums text-text-muted">{percent}</span>
          )}
        </span>
      </div>
      <BreakdownBar percent={row.percent} />
      {(delta !== undefined || (lifetimeValue !== undefined && lifetimeValue !== null)) && (
        <div className="mt-1 flex flex-wrap items-baseline justify-end gap-3 text-micro text-text-faint">
          {delta !== undefined && (
            <span className="tabular-nums">
              {s.details.breakdown.delta}{" "}
              {delta > 0 ? `+${formatNumber(s, delta)}` : formatNumber(s, delta)}
              {s.details.value.perSecond}
            </span>
          )}
          {lifetimeValue !== undefined && lifetimeValue !== null && (
            <span className="tabular-nums">
              {s.details.breakdown.lifetime} {formatNumber(s, lifetimeValue)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// BreakdownBar — the share of the section total. Presentational only: the
// number and the percentage next to it carry the same information for a
// screen reader, so the bar itself is aria-hidden rather than a second
// progressbar to tab through (§21).
function BreakdownBar({ percent }: { percent: number | null }) {
  return (
    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bar-track" aria-hidden="true">
      <div
        className="h-full rounded-full bg-accent transition-[width]"
        style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
      />
    </div>
  );
}
