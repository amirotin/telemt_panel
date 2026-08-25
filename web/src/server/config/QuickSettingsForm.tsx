import { ru } from "../../i18n/ru";
import { KVRow } from "../../ui/KVRow";
import { Input } from "../../ui/Input";
import { CONFIG_FIELDS, QUICK_SETTINGS_SECTIONS, unknownKeysInSection, type ConfigFieldDef } from "./configFields";
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
export function QuickSettingsForm({ sections, onChange }: QuickSettingsFormProps) {
  return (
    <div className="flex flex-col gap-4">
      {QUICK_SETTINGS_SECTIONS.map((section) => {
        const fields = CONFIG_FIELDS.filter((f) => f.section === section);
        const unknownKeys = unknownKeysInSection(section, sections[section]);
        return (
          <section key={section} className="rounded-xl border border-border bg-surface p-4">
            <h2 className="mb-3 text-sm font-semibold text-text">{ru.server.config.sections[section]}</h2>
            <div className="flex flex-col gap-3">
              {fields.map((field) => (
                <FieldInput
                  key={field.key}
                  field={field}
                  value={getSectionField(sections, field.section, field.key)}
                  onChange={(value) => onChange(setSectionField(sections, field.section, field.key, value))}
                />
              ))}
              {unknownKeys.length > 0 && (
                <div className="mt-2 border-t border-border pt-2">
                  <p className="mb-1 text-xs text-text-faint">{ru.server.config.unknownFieldsTitle}</p>
                  {unknownKeys.map((key) => (
                    <KVRow
                      key={key}
                      label={key}
                      value={formatUnknownValue(getSectionField(sections, section, key))}
                      monospace
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ConfigFieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = ru.server.config.fields[field.key as keyof typeof ru.server.config.fields] ?? field.key;

  if (field.kind === "bool") {
    return (
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-5 w-5 shrink-0"
        />
        <span className="text-sm text-text">{label}</span>
      </label>
    );
  }

  if (field.kind === "int") {
    return (
      <label className="flex flex-col gap-1">
        <span className="text-sm text-text-muted">{label}</span>
        <Input
          type="number"
          inputMode="numeric"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-text-muted">{label}</span>
      <Input
        type="text"
        value={typeof value === "string" ? value : ""}
        autoCapitalize="off"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
