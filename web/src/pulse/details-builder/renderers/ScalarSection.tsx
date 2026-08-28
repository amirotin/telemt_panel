import { useStrings } from "../../../i18n";
import { describeField } from "../fieldCatalog";
import type { ScalarSectionInstance } from "../resolveSections";
import { FieldRow } from "./FieldRow";
import { SectionFrame } from "./SectionFrame";
import { EmptyNote } from "./NodeTree";
import { isSectionExpanded, showsAtMode, type DetailRenderContext } from "./context";

export interface ScalarSectionProps {
  instance: ScalarSectionInstance;
  ctx: DetailRenderContext;
}

// ScalarSection renders the scalar leaves of a stable record (§9.1) — the
// "Routing & capacity" block of the DC render.
//
// Every row is a §8.1 two-column row and nothing else: the resolver has
// already extracted any array or object bound here into its own section
// (§12.7), so this component never has to decide what to do with a
// container. Per-FIELD display modes are honoured here through the same
// `showsAtMode` predicate the section list uses — an `extended`-only field
// disappears in `basic` without the section itself disappearing.
export function ScalarSection({ instance, ctx }: ScalarSectionProps) {
  const s = useStrings();
  const absence = ctx.absenceFor?.(instance.sourceId);
  const rows = instance.rows.filter((row) =>
    showsAtMode(describeField(row.path, s, ctx.lookup).minMode, ctx.mode),
  );
  const expanded = isSectionExpanded(instance.id, instance.defaultExpanded, ctx.expandedSections);

  return (
    <SectionFrame
      id={instance.id}
      title={instance.title(s)}
      description={instance.description?.(s)}
      count={rows.length}
      expanded={expanded}
      onToggle={() => ctx.toggleSection(instance.id)}
    >
      {rows.length === 0 ? (
        <EmptyNote text={s.details.collection.noFields} />
      ) : (
        rows.map((row) => (
          <FieldRow
            key={row.path}
            path={row.path}
            value={row.value}
            present={row.present}
            ctx={ctx}
            {...(absence !== undefined ? { absence } : {})}
          />
        ))
      )}
    </SectionFrame>
  );
}
