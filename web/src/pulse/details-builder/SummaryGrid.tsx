import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { StatCard } from "../../ui/StatCard";
import { describeField } from "./fieldCatalog";
import type { FieldLookupContext } from "./fieldCatalog";
import { formatValue } from "./formatting";
import type { SummaryMetricDefinition, SummaryShortcut } from "./model";
import { showsAtMode } from "./renderers/context";
import { fieldLabel } from "./renderers/unknownFields";
import type { DisplayMode } from "../../display-mode";

type MetricTone = NonNullable<SummaryMetricDefinition<unknown>["tone"]>;

const TONE_CLASSES: Record<MetricTone, string> = {
  neutral: "",
  good: "text-ok",
  warn: "text-warn",
  bad: "text-error",
};

// §21: "status не кодируется только цветом". A tile that is amber because
// something is wrong says so with a glyph AND with a word for a screen
// reader; the colour is the third cue, not the only one. `good` gets no
// marker on purpose — "nothing is wrong" is the default reading of a tile,
// and a checkmark on every healthy number is noise.
const TONE_MARKERS: Record<MetricTone, string> = {
  neutral: "",
  good: "",
  warn: "!",
  bad: "!",
};

export interface SummaryGridProps<T> {
  metrics: readonly SummaryMetricDefinition<T>[];
  context: T;
  mode: DisplayMode;
  nowMs: number;
  /** §18.2: a metric MAY be a shortcut to a filter/sort; the plain control stays. */
  onShortcut?: (shortcut: SummaryShortcut) => void;
  /** Field-catalog scope, so an unlabelled metric is named the way the rows are. */
  lookup?: FieldLookupContext;
  /** §15.3: compact landscape packs the tiles tighter, dropping nothing. */
  dense?: boolean;
  className?: string;
}

// SummaryGrid is §6's optional summary node — the "Connections / Health /
// RTT p50 / Fresh coverage" strip of the DC render. Two columns on a phone,
// four from `sm:` up; the cards are the app's existing StatCard, not a new
// dashboard primitive.
//
// A metric with a `shortcut` becomes a button that ALSO applies that
// filter/sort (§18.2's interactive shortcut) — the ordinary control it
// duplicates is never removed, and the shortcut can only reach states that
// control can reach, because both write the same page-state slots.
export function SummaryGrid<T>({
  metrics,
  context,
  mode,
  nowMs,
  onShortcut,
  lookup,
  dense = false,
  className,
}: SummaryGridProps<T>) {
  const s = useStrings();
  const visible = metrics.filter((m) => showsAtMode(m.minMode, mode));
  if (visible.length === 0) return null;

  return (
    <div
      className={cn(
        "grid",
        dense ? "grid-cols-4 gap-2" : "grid-cols-2 gap-3 sm:grid-cols-4",
        className,
      )}
    >
      {visible.map((metric) => {
        const path = metric.path ?? metric.id;
        const field = describeField(path, s, lookup ?? {});
        // A tile is named by a HUMAN short label, not by the raw key the
        // §8.1 rows show: the renders read "Fresh coverage", never
        // `fresh_coverage_pct`. The key is the last resort, for a path the
        // catalog has never heard of.
        const label = metric.label ? metric.label(s) : (field.shortLabel ?? fieldLabel(path));
        const raw = metric.value(context);
        const formatted = formatValue(raw, s, {
          nowMs,
          ...(metric.format !== undefined ? { formatter: metric.format } : {}),
          ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
        });
        const tone = metric.tone ?? "neutral";
        const marker = TONE_MARKERS[tone];
        const card = (
          <StatCard
            label={label}
            className={cn(dense && "gap-0.5 p-2")}
            value={
              <span className={cn("inline-flex items-baseline gap-1", TONE_CLASSES[tone])}>
                {marker !== "" && (
                  <>
                    <span aria-hidden="true" className="text-sm">
                      {marker}
                    </span>
                    <span className="sr-only">
                      {tone === "bad" ? s.details.summary.bad : s.details.summary.warn}
                    </span>
                  </>
                )}
                <span className={cn(dense && "text-lg")}>{formatted.text}</span>
              </span>
            }
          />
        );
        if (metric.shortcut && onShortcut) {
          const shortcut = metric.shortcut;
          return (
            <button
              key={metric.id}
              type="button"
              className="text-left"
              onClick={() => onShortcut(shortcut)}
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
