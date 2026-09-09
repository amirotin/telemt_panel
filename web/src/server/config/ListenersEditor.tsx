import { useState } from "react";
import type { TelemtConfigField } from "../../lib/api/generated/types.gen";
import { useStrings } from "../../i18n";
import { IconChevronDown, IconChevronUp, IconCopy, IconTrash } from "../../ui/icons";
import { getConfigValue, setConfigValue } from "./configCatalog.helpers";
import { AddRecordButton, RecordIconButton } from "./ConfigEditorControls";
import { ConfigFieldRow } from "./ConfigFieldControls";
import { pathLeaf, asRecordArray } from "./configRecords";

export function ListenersEditor({ fields, sections, advanced, onChange }: {
  fields: TelemtConfigField[];
  sections: Record<string, unknown>;
  advanced: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const copy = useStrings().server.config.catalog;
  const records = asRecordArray(getConfigValue(sections, "server.listeners"));
  const [expandedIndexes, setExpandedIndexes] = useState<number[]>([0]);
  const recordFields = fields.filter((field) => field.path.startsWith("server.listeners[]"));
  const updateRecords = (next: Array<Record<string, unknown>>) => onChange(setConfigValue(sections, "server.listeners", next));

  return (
    <div>
      <div className="pt-3">
        {records.length === 0 ? (
          <p className="border-y border-border py-6 text-center text-meta text-text-muted">{copy.noListenersConfigured}</p>
        ) : records.map((record, index) => {
          const transport = String(record["transport"] ?? "mtproxy");
          const visible = listenerFieldsForRecord(recordFields, record, advanced);
          const expanded = expandedIndexes.includes(index);
          const bind = listenerBindAddress(record);
          const announce = String(record["announce"] ?? record["announce_ip"] ?? "");
          const trustedCount = Array.isArray(record["web_trusted_proxy_cidrs"])
            ? record["web_trusted_proxy_cidrs"].length
            : 0;
          const detail = transport === "web"
            ? copy.listenerTrustedProxies.replace("{count}", String(trustedCount))
            : `${copy.listenerPublicAddress}: ${announce || copy.listenerAutomaticAddress}`;
          const canDelete = records.length > 1;
          const duplicateRecord = () => {
            const duplicate = cloneListenerRecord(record);
            updateRecords([...records.slice(0, index + 1), duplicate, ...records.slice(index + 1)]);
            setExpandedIndexes([index + 1]);
          };
          const deleteRecord = () => {
            updateRecords(records.filter((_, itemIndex) => itemIndex !== index));
            setExpandedIndexes((current) => current.filter((item) => item !== index).map((item) => item > index ? item - 1 : item));
          };

          return (
            <section key={index} className="border-b border-border first:border-t">
              <header className="grid min-h-[70px] grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-2.5 py-2.5">
                <span className="grid size-9 place-items-center rounded-lg border border-border bg-accent/8 text-sm font-bold text-accent" aria-hidden="true">
                  {transport === "web" ? "W" : "⇄"}
                </span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <strong className="truncate text-sm font-semibold text-text">{bind}</strong>
                    <em className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-micro font-bold not-italic text-accent">
                      {transport === "web" ? copy.listenerWeb : copy.listenerMtproxy}
                    </em>
                  </span>
                  <small className="mt-1 block truncate text-micro text-text-faint">{detail}</small>
                </span>
                <span className="flex items-center gap-1">
                  <span className="hidden items-center gap-1 sm:flex">
                    <RecordIconButton label={copy.duplicateRecord} onClick={duplicateRecord}>
                      <IconCopy className="size-4" />
                    </RecordIconButton>
                    <RecordIconButton
                      label={canDelete ? copy.deleteRecord : copy.lastListenerRequired}
                      danger
                      disabled={!canDelete}
                      onClick={deleteRecord}
                    >
                      <IconTrash className="size-4" />
                    </RecordIconButton>
                  </span>
                  <RecordIconButton
                    label={expanded ? copy.collapseRecord : copy.expandRecord}
                    onClick={() => setExpandedIndexes((current) => expanded ? current.filter((item) => item !== index) : [...current, index])}
                  >
                    {expanded ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
                  </RecordIconButton>
                </span>
              </header>
              {expanded && (
                <div className="border-t border-border/70 sm:pl-2">
                  {visible.map((field) => {
                    const concretePath = field.path.replace("[]", `[${index}]`);
                    return (
                      <ConfigFieldRow
                        key={concretePath}
                        instance={{ field, concretePath, value: getConfigValue(sections, concretePath) }}
                        advanced={advanced}
                        onChange={(value) => {
                          if (pathLeaf(field.path) === "transport") {
                            const next = [...records];
                            next[index] = listenerForTransport(record, String(value));
                            updateRecords(next);
                            return;
                          }
                          onChange(setConfigValue(sections, concretePath, value));
                        }}
                      />
                    );
                  })}
                  <div className="flex gap-2 border-t border-border/70 py-3 sm:hidden">
                    <button
                      type="button"
                      className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-meta font-semibold text-text-muted"
                      onClick={duplicateRecord}
                    >
                      <IconCopy className="size-4" />
                      {copy.duplicateRecord}
                    </button>
                    <button
                      type="button"
                      disabled={!canDelete}
                      className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-bad/8 px-3 text-meta font-semibold text-bad disabled:cursor-not-allowed disabled:opacity-35"
                      onClick={deleteRecord}
                    >
                      <IconTrash className="size-4" />
                      {canDelete ? copy.deleteRecord : copy.lastListenerShort}
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <AddRecordButton onClick={() => {
        updateRecords([...records, {
          ip: "0.0.0.0",
          port: nextListenerPort(records),
          transport: "mtproxy",
        }]);
        setExpandedIndexes([records.length]);
      }}>
        {copy.addListener}
      </AddRecordButton>

      <div className="mt-3 flex gap-2.5 rounded-lg border border-accent/20 bg-accent/[0.045] p-3 text-meta leading-relaxed text-text-muted">
        <span className="text-accent" aria-hidden="true">↻</span>
        <span><strong className="text-text">{copy.listenerArrayTitle}</strong> {copy.listenerArrayHint}</span>
      </div>
    </div>
  );
}

function listenerFieldsForRecord(fields: TelemtConfigField[], record: Record<string, unknown>, advanced: boolean): TelemtConfigField[] {
  const order = [
    "transport", "ip", "port", "announce", "announce_ip", "proxy_protocol", "reuse_allow", "client_mss",
    "web_trusted_proxy_cidrs", "web_client_ip_source", "synlimit", "synlimit_seconds", "synlimit_hitcount",
    "synlimit_burst", "synlimit_ios_seconds", "synlimit_ios_hitcount", "synlimit_ios_burst",
    "synlimit_hashlimit_expire_ms", "synlimit_hashlimit_size",
  ];
  const sorted = [...fields].sort((a, b) => order.indexOf(pathLeaf(a.path)) - order.indexOf(pathLeaf(b.path)));
  const transport = String(record["transport"] ?? "mtproxy");
  if (transport === "web") {
    const webFields = new Set(["transport", "ip", "port", "web_trusted_proxy_cidrs"]);
    return sorted.filter((field) => webFields.has(pathLeaf(field.path)));
  }

  const mtproxyFields = sorted.filter((field) => !pathLeaf(field.path).startsWith("web_"));
  if (!advanced) return mtproxyFields.filter((field) => ["transport", "ip", "port", "announce"].includes(pathLeaf(field.path)));
  const synlimitEnabled = record["synlimit"] !== false && record["synlimit"] !== undefined;
  return mtproxyFields.filter((field) => {
    const key = pathLeaf(field.path);
    if (key === "announce_ip") return record["announce"] === undefined && record["announce_ip"] !== undefined;
    if (key.startsWith("synlimit_") && !synlimitEnabled) return false;
    return true;
  });
}

function listenerForTransport(record: Record<string, unknown>, transport: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...record, transport };
  if (transport === "web") {
    for (const key of Object.keys(next)) {
      if (key === "announce" || key === "announce_ip" || key === "client_mss" || key.startsWith("synlimit")) delete next[key];
    }
    next["proxy_protocol"] = false;
    next["reuse_allow"] = false;
    next["web_client_ip_source"] = "x_forwarded_for";
    if (!Array.isArray(next["web_trusted_proxy_cidrs"]) || next["web_trusted_proxy_cidrs"].length === 0) {
      next["web_trusted_proxy_cidrs"] = ["127.0.0.1/32"];
    }
  } else {
    delete next["web_client_ip_source"];
    delete next["web_trusted_proxy_cidrs"];
  }
  return next;
}

function listenerBindAddress(record: Record<string, unknown>): string {
  const ip = String(record["ip"] ?? "0.0.0.0");
  const port = String(record["port"] ?? "—");
  return ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
}

function cloneListenerRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
}

function nextListenerPort(records: Array<Record<string, unknown>>): number {
  const used = new Set(records.map((record) => Number(record["port"])).filter(Number.isFinite));
  if (!used.has(443)) return 443;
  let port = 8443;
  while (used.has(port) && port < 65535) port += 1;
  return port;
}
