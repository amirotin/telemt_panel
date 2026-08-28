import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export type DescribedRowNameStyle = "field" | "label";

export interface DescribedRowProps {
  /** Parameter name — Telemt's own field name, or a human label. */
  name: ReactNode;
  /**
   * Short description, ALWAYS visible directly under the name (spec §8.1:
   * "описание видимо постоянно, а не только в tooltip"). Name and
   * description form ONE left-hand semantic block; a separate description
   * column is forbidden.
   */
  description?: ReactNode;
  value: ReactNode;
  /** Secondary hint under the value — a zeroMeaning, a delta, an item path. */
  valueNote?: ReactNode;
  /** Absolute rendering of a relative value, reachable as a native tooltip. */
  valueTitle?: string;
  /**
   * "field" (default) — a Telemt field name, monospace and semibold, the way
   * every Details render draws it. "label" — a human-written label in the
   * meta type scale; this is the legacy KVRow look, kept for the config /
   * security / platform screens that label their own rows.
   */
  nameStyle?: DescribedRowNameStyle;
  monospaceValue?: boolean;
  /** Apply tabular numerals — set for any rendered number (spec §13). */
  numeric?: boolean;
  /** The value is an absence sentence, not a value: quieter, never bold. */
  absent?: boolean;
  className?: string;
}

// DescribedRow is the spec's §8.1 scalar row and the app's ONE
// "parameter — value" primitive (it replaces KVRow, which is now a thin
// wrapper over it):
//
//   Название параметра                 Значение
//   Краткое описание прямо под ним
//
// Two columns, never three. The value column is capped at 42 % of the row
// (§15.2's "правая колонка ограничена примерно 38–42%") and wraps inside
// itself — `break-words`, never `truncate`: §13.2 requires a long value to
// stay fully readable and selectable rather than being cut with an ellipsis
// or pushed past the viewport edge. `items-start` because the description
// makes the left block taller than the value, and a centered value would
// float away from the name it belongs to.
export function DescribedRow({
  name,
  description,
  value,
  valueNote,
  valueTitle,
  nameStyle = "field",
  monospaceValue,
  numeric,
  absent,
  className,
}: DescribedRowProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 border-b border-border py-2.5 last:border-b-0",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "break-words",
            nameStyle === "field"
              ? "font-mono text-[12.5px] font-semibold text-text"
              : "text-meta text-text-muted",
          )}
        >
          {name}
        </div>
        {description !== undefined && description !== "" && (
          <p className="mt-0.5 break-words text-meta leading-snug text-text-muted">{description}</p>
        )}
      </div>
      <div className="min-w-0 max-w-[42%] shrink-0 text-right">
        <div
          className={cn(
            "break-words text-row",
            numeric && "tabular-nums",
            monospaceValue && "font-mono",
            absent ? "text-text-faint" : "font-semibold text-text",
          )}
          title={valueTitle}
        >
          {value}
        </div>
        {valueNote !== undefined && valueNote !== "" && (
          <div className="mt-0.5 break-words text-micro text-text-faint">{valueNote}</div>
        )}
      </div>
    </div>
  );
}
