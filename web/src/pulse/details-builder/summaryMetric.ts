import type { Dict } from "../../i18n";
import { describeField, type FieldLookupContext } from "./fieldCatalog";
import { formatValue } from "./formatting";
import type { SummaryMetricDefinition, SummaryTone } from "./model";
import { fieldLabel } from "./renderers/unknownFields";

export interface ResolvedSummaryMetric {
  id: string;
  label: string;
  /** The formatted figure — never a raw value, never a bare `null`. */
  text: string;
  tone: SummaryTone;
}

// resolveSummaryMetric turns a §6 summary metric into the three strings a
// surface needs. Factored out of SummaryGrid so the Пульс hub's preview
// cards can read the SAME tiles the Details page shows: a hub card that
// derived its own numbers would eventually disagree with the page it links
// to, which is the one thing a preview must never do.
//
// Naming follows the spec's own register split: an explicit `label` wins,
// then the field catalog's SHORT label for the metric's path ("Покрытие",
// not `coverage_pct`), and only a path the catalog has never seen falls back
// to the raw key.
export function resolveSummaryMetric<T>(
  metric: SummaryMetricDefinition<T>,
  context: T,
  s: Dict,
  opts: { nowMs: number; lookup?: FieldLookupContext },
): ResolvedSummaryMetric {
  const path = metric.path ?? metric.id;
  const field = describeField(path, s, opts.lookup ?? {});
  const label = metric.label ? metric.label(s) : (field.shortLabel ?? fieldLabel(path));
  const formatted = formatValue(metric.value(context), s, {
    nowMs: opts.nowMs,
    ...(metric.format !== undefined ? { formatter: metric.format } : {}),
    ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
  });
  const tone = typeof metric.tone === "function" ? metric.tone(context) : (metric.tone ?? "neutral");
  return { id: metric.id, label, text: formatted.text, tone };
}
