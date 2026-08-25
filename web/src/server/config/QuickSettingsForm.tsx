import { ru, useStrings } from "../../i18n";
import { KVRow } from "../../ui/KVRow";
import { Input } from "../../ui/Input";
import { Toggle } from "../../ui/Toggle";
import { CardTitle } from "../../ui/Card";
import { SectionLabel } from "../../ui/SectionLabel";
import {
  CONFIG_FIELDS,
  QUICK_SETTINGS_SECTIONS,
  unknownKeysInSection,
  type ConfigFieldDef,
} from "./configFields";
import { getSectionField, setSectionField } from "./configPatch.helpers";

function formatUnknownValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? ru.common.yes : ru.common.no;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface QuickSettingsFormProps {
  sections: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

// QuickSettingsForm renders the three editable sections the task brief
// scopes this form to (general/timeouts/censorship): known fields as
// proper typed inputs (configFields.ts's catalog), everything else in
// those sections read-only as a KVRow — "completeness" (06-ui.md), nothing
// in these sections is ever silently hidden even though the form only
// understands a handful of keys.
//
// Each section is one card of hairline-separated rows, the prototype's
// «label слева, значение справа» config layout. Rows stack on a phone
// (a 360px row cannot hold a readable label next to a usable input) and
// sit side by side from `sm:` up.
export function QuickSettingsForm({
  sections,
  onChange,
}: QuickSettingsFormProps) {
  const s = useStrings();
  return (
    <div className="flex flex-col gap-2.5">
      {QUICK_SETTINGS_SECTIONS.map((section) => {
        const fields = CONFIG_FIELDS.filter((f) => f.section === section);
        const unknownKeys = unknownKeysInSection(section, sections[section]);
        return (
          <section
            key={section}
            className="rounded-xl bg-surface px-4 pb-1 pt-3.5"
          >
            <CardTitle className="pb-1">
              {s.server.config.sections[section]}
            </CardTitle>
            {fields.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={getSectionField(sections, field.section, field.key)}
                onChange={(value) =>
                  onChange(
                    setSectionField(sections, field.section, field.key, value),
                  )
                }
              />
            ))}
            {unknownKeys.length > 0 && (
              <div className="border-t border-border pt-2.5">
                <SectionLabel className="mb-0.5">
                  {s.server.config.unknownFieldsTitle}
                </SectionLabel>
                {unknownKeys.map((key) => (
                  <KVRow
                    key={key}
                    label={key}
                    value={formatUnknownValue(
                      getSectionField(sections, section, key),
                    )}
                    monospace
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

const ROW_CLASS =
  "flex flex-col gap-1.5 border-b border-border py-2.5 last:border-b-0 sm:min-h-[52px] sm:flex-row sm:items-center sm:gap-3";
const LABEL_CLASS = "text-meta text-text-muted sm:min-w-0 sm:flex-1";

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ConfigFieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const s = useStrings();
  const label =
    s.server.config.fields[
      field.key as keyof typeof ru.server.config.fields
    ] ?? field.key;

  if (field.kind === "bool") {
    return (
      <div className="flex min-h-[52px] items-center gap-3 border-b border-border py-2 last:border-b-0">
        <span className="min-w-0 flex-1 text-meta text-text-muted">
          {label}
        </span>
        <Toggle
          aria-label={label}
          checked={value === true}
          onChange={onChange}
        />
      </div>
    );
  }

  if (field.kind === "int") {
    return (
      <label className={ROW_CLASS}>
        <span className={LABEL_CLASS}>{label}</span>
        <Input
          type="number"
          inputMode="numeric"
          className="sm:w-44 sm:shrink-0"
          value={typeof value === "number" ? value : ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? 0 : Number(e.target.value))
          }
        />
      </label>
    );
  }

  return (
    <label className={ROW_CLASS}>
      <span className={LABEL_CLASS}>{label}</span>
      <Input
        type="text"
        className="sm:w-56 sm:shrink-0"
        value={typeof value === "string" ? value : ""}
        autoCapitalize="off"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
