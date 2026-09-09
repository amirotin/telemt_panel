import { useState } from "react";
import type { TelemtConfigField } from "../../lib/api/generated/types.gen";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { IconChevronDown, IconChevronUp, IconCopy, IconTrash } from "../../ui/icons";
import { getConfigValue, setConfigValue } from "./configCatalog.helpers";
import { Subsection, AddRecordButton, RecordIconButton } from "./ConfigEditorControls";
import { GenericFields, ConfigFieldRow } from "./ConfigFieldControls";
import { pathLeaf, asRecordArray } from "./configRecords";

export function UpstreamsEditor({ fields, sections, advanced, onChange }: {
  fields: TelemtConfigField[];
  sections: Record<string, unknown>;
  advanced: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const copy = useStrings().server.config.catalog;
  const records = asRecordArray(getConfigValue(sections, "upstreams"));
  const [expandedIndexes, setExpandedIndexes] = useState<number[]>([0]);
  const recordFields = fields.filter((field) => field.path.startsWith("upstreams[]"));
  const otherFields = fields.filter((field) => !field.path.startsWith("upstreams[]"));
  const updateRecords = (next: Array<Record<string, unknown>>) => onChange(setConfigValue(sections, "upstreams", next));

  return (
    <div>
      <div className="pt-3">
        {records.length === 0 ? (
          <p className="border-y border-border py-6 text-center text-meta text-text-muted">{copy.noUpstreams}</p>
        ) : records.map((record, index) => {
          const visible = upstreamFieldsForRecord(recordFields, record, advanced);
          const type = String(record["type"] ?? "direct");
          const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
          const endpoint = String(record["url"] ?? record["address"] ?? "");
          const expanded = expandedIndexes.includes(index);
          return (
            <section key={index} className="border-b border-border first:border-t">
              <header className="grid min-h-[66px] grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-2.5 py-2.5">
                <span className="grid size-9 place-items-center rounded-lg border border-border bg-accent/8 text-accent">↗</span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-semibold text-text">{typeLabel} · {endpoint || copy.primaryRoute}</strong>
                  <small className="mt-0.5 block truncate text-micro text-text-faint">{record["scopes"] ? `scopes: ${String(record["scopes"])}` : copy.allDcScopes}</small>
                </span>
                <span className="flex items-center gap-1">
                  <em className={cn("hidden rounded-full px-2 py-1 text-micro font-bold not-italic sm:inline-flex", record["enabled"] === false ? "bg-surface-2 text-text-faint" : "bg-ok/10 text-ok")}>
                    {record["enabled"] === false ? copy.disabled : copy.active}
                  </em>
                  <RecordIconButton label={copy.duplicateRecord} onClick={() => {
                    updateRecords([...records.slice(0, index + 1), { ...record }, ...records.slice(index + 1)]);
                    setExpandedIndexes([index + 1]);
                  }}>
                    <IconCopy className="size-4" />
                  </RecordIconButton>
                  <RecordIconButton label={copy.deleteRecord} danger onClick={() => {
                    updateRecords(records.filter((_, itemIndex) => itemIndex !== index));
                    setExpandedIndexes((current) => current.filter((item) => item !== index).map((item) => item > index ? item - 1 : item));
                  }}>
                    <IconTrash className="size-4" />
                  </RecordIconButton>
                  <RecordIconButton
                    label={expanded ? copy.collapseRecord : copy.expandRecord}
                    onClick={() => setExpandedIndexes((current) => expanded ? current.filter((item) => item !== index) : [...current, index])}
                  >
                    {expanded ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
                  </RecordIconButton>
                </span>
              </header>
              {expanded && <div className="border-t border-border/70 sm:pl-2">
                {visible.map((field) => {
                  const concretePath = field.path.replace("[]", `[${index}]`);
                  return (
                    <ConfigFieldRow
                      key={concretePath}
                      instance={{ field, concretePath, value: getConfigValue(sections, concretePath) }}
                      advanced={advanced}
                      onChange={(value) => onChange(setConfigValue(sections, concretePath, value))}
                    />
                  );
                })}
              </div>}
            </section>
          );
        })}
      </div>

      <AddRecordButton onClick={() => {
        updateRecords([...records, { enabled: true, scopes: "", type: "direct", weight: 1 }]);
        setExpandedIndexes([records.length]);
      }}>
        {copy.addUpstream}
      </AddRecordButton>

      <div className="mt-3 flex gap-2.5 rounded-lg border border-accent/20 bg-accent/[0.045] p-3 text-meta leading-relaxed text-text-muted">
        <span className="text-accent" aria-hidden="true">↻</span>
        <span><strong className="text-text">{copy.upstreamArrayTitle}</strong> {copy.upstreamArrayHint}</span>
      </div>

      {otherFields.length > 0 && (
        <Subsection title={copy.dcRouting} count={otherFields.length}>
          <GenericFields fields={otherFields} sections={sections} advanced={advanced} onChange={onChange} />
        </Subsection>
      )}
    </div>
  );
}

function upstreamFieldsForRecord(fields: TelemtConfigField[], record: Record<string, unknown>, advanced: boolean): TelemtConfigField[] {
  const order = ["type", "enabled", "weight", "scopes", "address", "url", "username", "password", "user_id", "prefer", "ipv4", "ipv6", "interface", "bind_addresses", "bindtodevice", "force_bind"];
  const sorted = [...fields].sort((a, b) => order.indexOf(pathLeaf(a.path)) - order.indexOf(pathLeaf(b.path)));
  if (advanced) return sorted;
  const type = String(record["type"] ?? "direct");
  const essentials = new Set(["type", "enabled", "weight", "scopes"]);
  if (type === "socks4" || type === "socks5") ["address", "username", "password"].forEach((key) => essentials.add(key));
  if (type === "shadowsocks") ["url", "password", "user_id"].forEach((key) => essentials.add(key));
  return sorted.filter((field) => essentials.has(pathLeaf(field.path)) || record[pathLeaf(field.path)] !== undefined);
}
