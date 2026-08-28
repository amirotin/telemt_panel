import { useStrings } from "../../../i18n";
import { DescribedRow } from "../../../ui/DescribedRow";
import { describeField } from "../fieldCatalog";
import { formatValue } from "../formatting";
import type { FormatterName } from "../formatting";
import type { FieldUnit } from "../model";
import type { DetailRenderContext, ForcedAbsence } from "./context";
import { fieldLabel } from "./unknownFields";

export interface FieldRowProps {
  path: string;
  value: unknown;
  /** False when the key never arrived — a different row from a collected null (§13.1). */
  present?: boolean;
  ctx: DetailRenderContext;
  /** Overrides the catalog's formatter for this one binding. */
  format?: FormatterName;
  unit?: FieldUnit;
  /** Absence forced by the section's source state, overriding the value entirely. */
  absence?: ForcedAbsence;
  /** Overrides the label — dynamic-map keys are data and are shown verbatim (§11.2). */
  label?: string;
  /** Extra hint under the value — a per-second delta, an element path. */
  valueNote?: string;
  className?: string;
}

// FieldRow binds ONE normalized path to the §8.1 row: the catalog supplies
// the name and the always-visible description, `formatValue` supplies the
// text, and DescribedRow draws the two columns.
//
// It never decides how to render a container: `formatValue` answers an
// array or an object with the "составное значение" sentence, so a broken
// definition produces an honest row instead of "10 items" or a
// comma-joined list (§10, §12.7).
export function FieldRow({
  path,
  value,
  present,
  ctx,
  format,
  unit,
  absence,
  label,
  valueNote,
  className,
}: FieldRowProps) {
  const s = useStrings();
  const field = describeField(path, s, ctx.lookup);
  const formatted = formatValue(value, s, {
    nowMs: ctx.nowMs,
    ...(format ?? field.format ? { formatter: (format ?? field.format) as FormatterName } : {}),
    ...(unit ?? field.unit ? { unit: (unit ?? field.unit) as FieldUnit } : {}),
    ...(field.nullMeaning !== undefined ? { nullMeaning: field.nullMeaning } : {}),
    ...(field.zeroMeaning !== undefined ? { zeroMeaning: field.zeroMeaning } : {}),
    ...(present !== undefined ? { present } : {}),
    ...(absence !== undefined ? { absence } : {}),
  });

  return (
    <DescribedRow
      name={label ?? field.label ?? fieldLabel(path)}
      description={field.description}
      value={formatted.text}
      {...(formatted.title !== undefined ? { valueTitle: formatted.title } : {})}
      valueNote={valueNote ?? formatted.note}
      numeric={formatted.numeric === true}
      monospaceValue={formatted.monospace === true}
      absent={formatted.absence !== undefined}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
