import { useState } from "react";
import type { TelemtConfigCatalog, TelemtConfigField } from "../../lib/api/generated/types.gen";
import { useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Toggle } from "../../ui/Toggle";
import { fieldInstances, setConfigValue, type ConfigFieldInstance } from "./configCatalog.helpers";
import { configFieldDescription, configFieldLabel } from "./configFieldPresentation";

export function GenericFields({ fields, sections, advanced, catalog, onChange }: {
  fields: TelemtConfigField[];
  sections: Record<string, unknown>;
  advanced: boolean;
  catalog?: TelemtConfigCatalog;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <div>
      {fields.flatMap((field) =>
        fieldInstances(sections, field).map((instance) => (
          <ConfigFieldRow
            key={instance.concretePath}
            instance={instance}
            advanced={advanced}
            groupName={catalog?.groups.find((item) => item.id === field.group)?.short}
            onChange={(value) => onChange(setConfigValue(sections, instance.concretePath, value))}
          />
        )),
      )}
    </div>
  );
}

export function ConfigFieldRow({ instance, advanced, groupName, onChange }: {
  instance: ConfigFieldInstance;
  advanced: boolean;
  groupName?: string;
  onChange: (value: unknown) => void;
}) {
  const copy = useStrings().server.config.catalog;
  const { field, value, concretePath, recordLabel } = instance;
  const label = configFieldLabel(field, copy.labels as Record<string, string>);
  const requiresRestart = field.apply.includes("restart");
  return (
    <div className="grid min-h-[74px] gap-2 border-b border-border/75 py-3.5 sm:grid-cols-[minmax(180px,1fr)_minmax(170px,225px)] sm:items-center sm:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-text">{label}</span>
          {recordLabel && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-micro font-semibold text-text-faint">{recordLabel}</span>}
          {advanced && groupName && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-micro font-semibold text-text-faint">{groupName}</span>}
          {requiresRestart && <span className="rounded bg-warn/10 px-1.5 py-0.5 text-micro font-bold text-warn">restart</span>}
        </div>
        <p className="mt-1 text-meta leading-relaxed text-text-muted">
          {advanced ? configFieldDescription(field, { restart: copy.applyRestart, conditional: copy.applyConditional, reload: copy.applyReload }) : normalFieldHint(field, copy)}
        </p>
        {advanced && <code className="mt-1 block break-all font-mono text-micro text-accent/80">{concretePath}</code>}
      </div>
      <FieldControl field={field} value={value} label={label} onChange={onChange} />
    </div>
  );
}

export function FieldControl({ field, value, label, onChange }: { field: TelemtConfigField; value: unknown; label: string; onChange: (value: unknown) => void }) {
  const copy = useStrings().server.config.catalog;
  if (field.kind === "boolean") {
    return <div className="flex min-h-11 items-center justify-between gap-3 sm:justify-end"><span className="text-meta text-text-muted sm:hidden">{value === true ? copy.enabled : copy.disabled}</span><Toggle checked={value === true} onChange={onChange} aria-label={label} /></div>;
  }
  if (field.kind === "enum") {
    return <Select value={value === false ? "false" : String(value ?? "")} onChange={(event) => onChange(enumValue(field, event.target.value))} aria-label={label}>{value === undefined && <option value="">{copy.unset}</option>}{field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</Select>;
  }
  if (field.kind === "integer" || field.kind === "decimal") {
    const unsafe = typeof value === "number" && !Number.isSafeInteger(value) && field.kind === "integer";
    return <div><Input value={value === undefined ? "" : String(value)} inputMode={field.kind === "integer" ? "numeric" : "decimal"} monospace disabled={unsafe} aria-label={label} onChange={(event) => { const parsed = Number(event.target.value); if (event.target.value !== "" && Number.isFinite(parsed) && (field.kind !== "integer" || Number.isSafeInteger(parsed))) onChange(parsed); }} />{unsafe && <p className="mt-1 text-micro text-warn">{copy.exactToml}</p>}</div>;
  }
  if (field.kind === "string_list" || field.kind === "integer_list") {
    const list = Array.isArray(value) ? value : [];
    return <Input value={list.join(", ")} placeholder={copy.commaSeparated} aria-label={label} onChange={(event) => { const values = event.target.value.split(",").map((item) => item.trim()).filter(Boolean); onChange(field.kind === "integer_list" ? values.map(Number) : values); }} />;
  }
  if (field.kind === "map" || field.kind === "structure") {
    return <JSONControl key={JSON.stringify(value)} label={label} value={value} onChange={onChange} readOnly={field.kind === "structure"} />;
  }
  return <Input type={field.secret ? "password" : "text"} value={typeof value === "string" ? value : value === undefined ? "" : String(value)} placeholder={field.default_value === "—" ? copy.unset : field.default_value} autoCapitalize="off" spellCheck={false} aria-label={label} onChange={(event) => onChange(event.target.value)} />;
}

function JSONControl({ label, value, onChange, readOnly }: { label: string; value: unknown; onChange: (value: unknown) => void; readOnly: boolean }) {
  const copy = useStrings().server.config.catalog;
  const [invalid, setInvalid] = useState(false);
  const [text, setText] = useState(JSON.stringify(value ?? (readOnly ? null : {})));
  return (
    <div>
      <textarea
        className={cn("min-h-20 w-full resize-y rounded-lg border bg-surface-2 px-3 py-2 font-mono text-[13px] leading-relaxed text-text focus-visible:border-accent", invalid ? "border-bad" : "border-border")}
        value={text}
        readOnly={readOnly}
        aria-label={label}
        onChange={(event) => { setText(event.target.value); setInvalid(false); }}
        onBlur={(event) => { if (readOnly) return; try { onChange(JSON.parse(event.target.value)); setInvalid(false); } catch { setInvalid(true); } }}
      />
      {invalid && <p className="mt-1 text-micro text-bad">{copy.invalidJson}</p>}
      {readOnly && <p className="mt-1 text-micro text-text-faint">{copy.structureHint}</p>}
    </div>
  );
}

function enumValue(field: TelemtConfigField, value: string): string | boolean | number {
  if (value === "false") return false;
  if (field.data_type === "4 or 6") return Number(value);
  return value;
}

function normalFieldHint(field: TelemtConfigField, copy: Dict["server"]["config"]["catalog"]): string {
  if (field.apply.includes("restart")) return copy.applyRestart;
  if (field.path === "web.enabled") return copy.webEnabledHint;
  if (field.path === "general.me2dc_fallback") return copy.fallbackHint;
  if (field.path === "general.use_middle_proxy") return copy.middleProxyHint;
  return `${copy.currentValue} · ${field.data_type}`;
}
