import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { fieldNameSegments } from "./fieldNameWrap";

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
  /**
   * Draw the value in semibold. Defaults to ON for `nameStyle="field"` (the
   * Details rows, where the value is the point of the row) and OFF for
   * `nameStyle="label"`, which is the weight the standalone KVRow had — the
   * config / security / platform screens must not change appearance just
   * because they now share this component.
   */
  emphasizeValue?: boolean;
  monospaceValue?: boolean;
  /**
   * Let the value wrap inside an unbreakable token (`overflow-wrap: anywhere`
   * rather than `break-word`). Set for addresses, identifiers and other
   * whitespace-free values, which the narrow value column otherwise pushes
   * around rather than wrapping.
   */
  wrapAnywhere?: boolean;
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
  emphasizeValue,
  monospaceValue,
  wrapAnywhere,
  numeric,
  absent,
  className,
}: DescribedRowProps) {
  const emphasized = emphasizeValue ?? nameStyle === "field";
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
          {/* A Telemt field name is one long unbreakable token; offer the
              browser the boundaries a reader recognizes rather than letting
              it split `stun_backoff_remainin`/`g_ms` at 360 px. */}
          {nameStyle === "field" && typeof name === "string"
            ? fieldNameSegments(name).map((segment, i) => (
                <Fragment key={i}>
                  {i > 0 && <wbr />}
                  {segment}
                </Fragment>
              ))
            : name}
        </div>
        {description !== undefined && description !== "" && (
          <p className="mt-0.5 break-words text-meta leading-snug text-text-muted">{description}</p>
        )}
      </div>
      <div className="min-w-0 max-w-[42%] shrink-0 text-right">
        <div
          className={cn(
            wrapAnywhere ? "wrap-anywhere" : "break-words",
            "text-row",
            numeric && "tabular-nums",
            monospaceValue && "font-mono",
            absent ? "text-text-faint" : cn("text-text", emphasized && "font-semibold"),
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
