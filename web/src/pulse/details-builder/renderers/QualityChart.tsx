import { useStrings } from "../../../i18n";
import { formatNumber } from "../../../i18n";
import { cn } from "../../../lib/cn";
import { Sparkline } from "../../../ui/Sparkline";
import type { CustomRendererOptions } from "../model";
import type { CustomSectionInstance } from "../resolveSections";
import { medianOf, readQualitySeries } from "./qualityChart.helpers";
import { EmptyNote } from "./NodeTree";
import type { DetailRenderContext } from "./context";

export interface QualityChartProps {
  instance: CustomSectionInstance;
  /** Part of the registry contract; this chart needs no clock of its own. */
  ctx?: DetailRenderContext;
  /** Unit word and count label, from the definition (§9.8). */
  options?: CustomRendererOptions;
}

// QualityChart is the REFERENCE custom renderer (§9.8): the one domain
// visual the standard section kinds cannot express, drawn with the app's
// own Sparkline primitive and plain elements — no charting library, per the
// wave's no-new-dependencies constraint.
//
// It is a chart AND a table: the bars carry the shape at a glance, and each
// bar's label and value are in the DOM under it, so the same information is
// available to a screen reader and to anyone who needs the number rather
// than the picture (§21). The Sparkline above them is the same series read
// as a trend.
export function QualityChart({ instance, options }: QualityChartProps) {
  const s = useStrings();
  const points = readQualitySeries(instance.value);

  if (points.length === 0) {
    return <EmptyNote text={s.details.chart.noSeries} />;
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values);
  const median = medianOf(points);
  const unit = options?.unit?.(s);
  const suffix = unit === undefined ? "" : ` ${unit}`;
  const countLabel = options?.countLabel?.(s);

  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-meta text-text-muted">
          {/* The count is named and the median carries the unit and the
              bars' own precision: «12 DC · медиана 88 мс» rather than
              «12 · медиана 87,84» beside columns reading 189. */}
          {formatNumber(s, points.length)}
          {countLabel === undefined ? "" : ` ${countLabel}`} · {s.details.chart.median}{" "}
          <span className="tabular-nums">
            {median === null ? "—" : `${formatNumber(s, roundForLabel(median))}${suffix}`}
          </span>
        </span>
        <Sparkline values={values} className="shrink-0" />
      </div>

      {/* A fixed 96px row height keeps every bar comparable; the bars scroll
          horizontally inside their own container rather than widening the
          page, which is the no-horizontal-overflow rule applied to a chart.
          The bar's percentage is of the MIDDLE band only — its own flex row —
          so a bar at 100 % stops where the band stops instead of growing over
          the value above it and the label below it. */}
      <div className="-mx-1 flex h-24 items-stretch gap-1 overflow-x-auto px-1" role="list">
        {points.map((point, i) => (
          <div
            key={`${point.label}#${i}`}
            role="listitem"
            className="flex h-full min-w-[40px] flex-1 flex-col"
            title={`${point.label}: ${formatNumber(s, point.value)}${suffix}`}
          >
            <span className="mb-1 text-center text-micro tabular-nums text-text-faint">
              {formatNumber(s, roundForLabel(point.value))}
            </span>
            <span className="flex min-h-0 flex-1 items-end">
              <span
                className={cn("w-full rounded-t bg-accent")}
                style={{ height: `${max > 0 ? Math.max(2, (point.value / max) * 100) : 2}%` }}
                aria-hidden="true"
              />
            </span>
            <span className="mt-1 truncate text-center text-micro text-text-muted">
              {point.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// roundForLabel keeps a bar's caption readable at 40 px wide. Telemt reports
// an RTT EMA as a float — 186.913 ms — and three decimals of a millisecond
// are noise on a bar chart, while the exact value stays one hover away in
// the element's `title`.
function roundForLabel(value: number): number {
  if (Number.isInteger(value)) return value;
  return Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 100) / 100;
}
