import { useStrings } from "../i18n";
import { cn } from "../lib/cn";

export type SparklineTone = "accent" | "ok" | "warn" | "error" | "muted";

/**
 * Alpha of the `area` variant's fill.
 *
 * It is this low on purpose: in `area` mode the chart is the BACKGROUND of a
 * tile whose label, value and caption are painted over it, so the composited
 * pair (`--text` / `--text-muted` over `tone@this over --surface`) has to
 * clear WCAG AA in all four themes. It does at 0.08 and does not at 0.10 —
 * styles/contrast.test.ts imports this constant and re-measures, so raising
 * it fails the suite rather than quietly dimming the caption.
 */
export const SPARKLINE_AREA_ALPHA = 0.08;

/** The line drawn on top of that fill — a hairline, not a text background. */
const LINE_ALPHA = 0.5;

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Which status colour to draw in. Defaults to the accent. */
  tone?: SparklineTone;
  /**
   * Fill the area under the line and stretch to the element's box instead of
   * keeping the viewBox's aspect — the tile-background treatment.
   */
  area?: boolean;
  /** Hide from the a11y tree — for a chart whose figure is already read out beside it. */
  decorative?: boolean;
}

// Sparkline — pure SVG, no charting library (web/README.md's dependency
// rule). Two variants of the same geometry: a small inline `line` next to a
// row's value, and `area`, which stretches to whatever box it is given and
// fills under the curve so a whole tile can be painted with it.
//
// Renders an empty box for 0-1 points rather than dividing by zero.
export function Sparkline({
  values,
  width = 96,
  height = 28,
  className,
  tone = "accent",
  area = false,
  decorative = false,
}: SparklineProps) {
  const s = useStrings();
  if (values.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden="true" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  // The area variant keeps a hairline of headroom so the stroke is not
  // clipped by the viewBox at the series' own maximum.
  const pad = area ? 2 : 0;
  const usable = height - pad * 2;

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = pad + (1 - (v - min) / range) * usable;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M${points.join("L")}`;
  const stroke = `rgb(var(--${tone}) / ${LINE_ALPHA})`;

  const a11y = decorative
    ? ({ "aria-hidden": "true" } as const)
    : ({ role: "img", "aria-label": s.ui.sparklineLabel } as const);

  return (
    <svg
      width={area ? undefined : width}
      height={area ? undefined : height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={area ? "none" : undefined}
      className={cn(area && "h-full w-full", className)}
      {...a11y}
    >
      {area && (
        <path
          d={`${line}L${width},${height}L0,${height}Z`}
          fill={`rgb(var(--${tone}) / ${SPARKLINE_AREA_ALPHA})`}
        />
      )}
      <path
        d={line}
        fill="none"
        stroke={area ? stroke : `rgb(var(--${tone}))`}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        // Without this, `preserveAspectRatio="none"` stretches the stroke
        // with the geometry and the line thickens horizontally.
        vectorEffect={area ? "non-scaling-stroke" : undefined}
      />
    </svg>
  );
}
