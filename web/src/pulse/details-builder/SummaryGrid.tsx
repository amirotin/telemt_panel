import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { StatCard } from "../../ui/StatCard";
import { formatValue } from "./formatting";
import type { FilterValue, SummaryMetricDefinition } from "./model";
import { showsAtMode } from "./renderers/context";
import type { DisplayMode } from "../../display-mode";

const TONE_CLASSES: Record<NonNullable<SummaryMetricDefinition<unknown>["tone"]>, string> = {
  neutral: "",
  good: "text-ok",
  warn: "text-warn",
  bad: "text-error",
};

export interface SummaryGridProps<T> {
  metrics: readonly SummaryMetricDefinition<T>[];
  context: T;
  mode: DisplayMode;
  nowMs: number;
  /** §18.2: a metric MAY be a shortcut to a filter; the plain control stays. */
  onFilter?: (key: string, value: FilterValue) => void;
  className?: string;
}

// SummaryGrid is §6's optional summary node — the "Connections / Health /
// RTT p50 / Fresh coverage" strip of the DC render. Two columns on a phone,
// four from `sm:` up; the cards are the app's existing StatCard, not a new
// dashboard primitive.
//
// A metric with a `filter` becomes a button that ALSO applies that filter
// (§18.2's interactive shortcut) — the ordinary control it duplicates is
// never removed.
export function SummaryGrid<T>({
  metrics,
  context,
  mode,
  nowMs,
  onFilter,
  className,
}: SummaryGridProps<T>) {
  const s = useStrings();
  const visible = metrics.filter((m) => showsAtMode(m.minMode, mode));
  if (visible.length === 0) return null;

  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-4", className)}>
      {visible.map((metric) => {
        const raw = metric.value(context);
        const formatted = formatValue(raw, s, {
          nowMs,
          ...(metric.format !== undefined ? { formatter: metric.format } : {}),
          ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
        });
        const card = (
          <StatCard
            label={metric.label(s)}
            value={<span className={TONE_CLASSES[metric.tone ?? "neutral"]}>{formatted.text}</span>}
          />
        );
        if (metric.filter && onFilter) {
          const filter = metric.filter;
          return (
            <button
              key={metric.id}
              type="button"
              className="text-left"
              onClick={() => onFilter(filter.key, filter.value)}
            >
              {card}
            </button>
          );
        }
        return <div key={metric.id}>{card}</div>;
      })}
    </div>
  );
}
