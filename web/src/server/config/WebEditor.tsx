import { useState, type ReactNode } from "react";
import type { TelemtConfigField } from "../../lib/api/generated/types.gen";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Toggle } from "../../ui/Toggle";
import { IconChevronDown, IconChevronUp, IconCopy, IconTrash } from "../../ui/icons";
import { getConfigValue, setConfigValue } from "./configCatalog.helpers";
import { configFieldDescription, configFieldLabel } from "./configFieldPresentation";
import { RouteChoice, SectionHeading, AddRecordButton, RecordListEmpty, RecordIconButton } from "./ConfigEditorControls";
import { GenericFields, ConfigFieldRow } from "./ConfigFieldControls";
import { asRecordArray } from "./configRecords";

const WEB_CARRIERS = ["https", "https-lanes", "websocket", "websocket-lanes"] as const;

const WEB_STRUCTURE_PATHS = new Set([
  "web.debug",
  "web.limits",
  "web.timeouts",
  "web.vhosts",
  "web.vhosts[].decoy",
  "web.vhosts[].profiles",
]);

export function WebEditor({ fields, sections, advanced, onChange }: {
  fields: TelemtConfigField[];
  sections: Record<string, unknown>;
  advanced: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const copy = useStrings().server.config.catalog;
  const labels = copy.labels as Record<string, string>;
  const fieldsByPath = new Map(fields.map((field) => [field.path, field]));
  const vhosts = asRecordArray(getConfigValue(sections, "web.vhosts"));
  const listeners = asRecordArray(getConfigValue(sections, "server.listeners"));
  const [expandedVhosts, setExpandedVhosts] = useState<number[]>([0]);
  const enabled = getConfigValue(sections, "web.enabled") === true;
  const fixedCarrier = String(getConfigValue(sections, "web.carrier") ?? "https");
  const rawCarriers = getConfigValue(sections, "web.carriers");
  const negotiatedCarriers = Array.isArray(rawCarriers) ? rawCarriers.map(String) : null;
  const hasWebListener = listeners.some((listener) => listener["transport"] === "web");
  const vhostsReady = vhosts.length > 0 && vhosts.every(webVhostReady);
  const ready = hasWebListener && vhostsReady;
  const update = (path: string, value: unknown) => onChange(setConfigValue(sections, path, value));
  const updateVhosts = (next: Array<Record<string, unknown>>) => update("web.vhosts", next);
  const rootField = (path: string) => {
    const field = fieldsByPath.get(path);
    if (!field) return null;
    return (
      <ConfigFieldRow
        key={path}
        instance={{ field, concretePath: path, value: getConfigValue(sections, path) }}
        advanced={advanced}
        onChange={(value) => update(path, value)}
      />
    );
  };
  const advancedGroups = [
    { id: "limits", title: copy.webLimitsTitle, hint: copy.webLimitsHint, fields: fields.filter((field) => field.path.startsWith("web.limits.") && !WEB_STRUCTURE_PATHS.has(field.path)) },
    { id: "timeouts", title: copy.webTimeoutsTitle, hint: copy.webTimeoutsHint, fields: fields.filter((field) => field.path.startsWith("web.timeouts.") && !WEB_STRUCTURE_PATHS.has(field.path)) },
    { id: "debug", title: copy.webDebugTitle, hint: copy.webDebugHint, fields: fields.filter((field) => field.path.startsWith("web.debug.") && field.path !== "web.debug.enabled" && !WEB_STRUCTURE_PATHS.has(field.path)) },
  ];

  return (
    <div className="min-w-0 space-y-7 py-4">
      <section className="rounded-xl border border-border bg-bg/25 p-3.5 sm:p-4">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold text-text">{copy.webStateTitle}</h3>
              <span className={cn("rounded-full px-2 py-0.5 text-micro font-bold", enabled ? "bg-ok/10 text-ok" : "bg-surface-2 text-text-faint")}>
                {enabled ? copy.enabled : copy.disabled}
              </span>
            </div>
            <p className="mt-1 text-meta leading-relaxed text-text-muted">{copy.webStateHint}</p>
          </div>
          <Toggle
            checked={enabled}
            disabled={!enabled && !ready}
            onChange={(value) => update("web.enabled", value)}
            aria-label={labels["web.enabled"] ?? copy.webStateTitle}
          />
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <WebRequirement ready={hasWebListener} title={copy.webListenerRequirement} hint={hasWebListener ? copy.webListenerReady : copy.webListenerMissing} />
          <WebRequirement ready={vhostsReady} title={copy.webVhostRequirement} hint={vhostsReady ? copy.webVhostsReady : copy.webVhostsMissing} />
        </div>
        {!ready && !enabled && <p className="mt-3 text-meta leading-relaxed text-warn">{copy.webEnableBlocked}</p>}
      </section>

      <section>
        <SectionHeading title={copy.webCarrierTitle} hint={copy.webCarrierHint} />
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-1.5" role="radiogroup" aria-label={copy.webCarrierModeLabel}>
          <RouteChoice
            active={negotiatedCarriers === null}
            title={copy.webCarrierFixed}
            hint={copy.webCarrierFixedHint}
            onClick={() => update("web.carriers", false)}
          />
          <RouteChoice
            active={negotiatedCarriers !== null}
            title={copy.webCarrierNegotiated}
            hint={copy.webCarrierNegotiatedHint}
            onClick={() => update("web.carriers", negotiatedCarriers ?? carrierOrderFromFallback(fixedCarrier))}
          />
        </div>

        <div className="mt-3 rounded-xl border border-border bg-bg/25 px-3 sm:px-4">
          {rootField("web.carrier")}
          {negotiatedCarriers !== null && (
            <div className="border-b border-border/75 py-4">
              <div>
                <strong className="text-sm font-semibold text-text">{copy.webCarrierOrderTitle}</strong>
                <p className="mt-1 text-meta leading-relaxed text-text-muted">{copy.webCarrierOrderHint}</p>
              </div>
              <div className="mt-3 space-y-1.5">
                {negotiatedCarriers.map((carrier, index) => (
                  <div key={`${carrier}-${index}`} className="grid min-h-11 grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-surface-2 px-2">
                    <span className="grid size-6 place-items-center rounded-full bg-accent/10 text-micro font-bold text-accent">{index + 1}</span>
                    <strong className="truncate text-meta font-semibold text-text">{carrier}</strong>
                    <span className="flex items-center">
                      <RecordIconButton label={copy.moveCarrierUp} disabled={index === 0} onClick={() => update("web.carriers", moveArrayItem(negotiatedCarriers, index, index - 1))}>
                        <IconChevronUp className="size-4" />
                      </RecordIconButton>
                      <RecordIconButton label={copy.moveCarrierDown} disabled={index === negotiatedCarriers.length - 1} onClick={() => update("web.carriers", moveArrayItem(negotiatedCarriers, index, index + 1))}>
                        <IconChevronDown className="size-4" />
                      </RecordIconButton>
                      <RecordIconButton label={copy.removeCarrier} danger disabled={negotiatedCarriers.length === 1} onClick={() => update("web.carriers", negotiatedCarriers.filter((_, itemIndex) => itemIndex !== index))}>
                        <IconTrash className="size-4" />
                      </RecordIconButton>
                    </span>
                  </div>
                ))}
              </div>
              {WEB_CARRIERS.some((carrier) => !negotiatedCarriers.includes(carrier)) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {WEB_CARRIERS.filter((carrier) => !negotiatedCarriers.includes(carrier)).map((carrier) => (
                    <button key={carrier} type="button" className="min-h-10 rounded-lg border border-dashed border-border-strong px-3 text-meta font-semibold text-accent hover:bg-accent/[0.05]" onClick={() => update("web.carriers", [...negotiatedCarriers, carrier])}>
                      + {carrier}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {negotiatedCarriers !== null && rootField("web.carrier_learning")}
          {negotiatedCarriers !== null && rootField("web.carrier_negotiation_aggressiveness")}
        </div>
        <p className="mt-2 text-micro leading-relaxed text-text-faint">{copy.webCarrierIosHint}</p>
      </section>

      <section>
        <SectionHeading title={copy.webVhostsTitle} hint={copy.webVhostsHint} />
        <RecordListEmpty show={vhosts.length === 0}>{copy.webNoVhosts}</RecordListEmpty>
        <div className="border-t border-border">
          {vhosts.map((vhost, index) => {
            const expanded = expandedVhosts.includes(index);
            const profiles = asRecordArray(vhost["profiles"]);
            const complete = webVhostReady(vhost);
            const duplicate = () => {
              updateVhosts([...vhosts.slice(0, index + 1), cloneConfigRecord(vhost), ...vhosts.slice(index + 1)]);
              setExpandedVhosts([index + 1]);
            };
            const remove = () => {
              updateVhosts(vhosts.filter((_, itemIndex) => itemIndex !== index));
              setExpandedVhosts((current) => current.filter((item) => item !== index).map((item) => item > index ? item - 1 : item));
            };
            return (
              <article key={index} className="border-b border-border">
                <header className="grid min-h-[74px] grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-2.5 py-2.5">
                  <span className={cn("grid size-9 place-items-center rounded-lg border text-sm font-bold", complete ? "border-ok/25 bg-ok/8 text-ok" : "border-warn/25 bg-warn/8 text-warn")} aria-hidden="true">W</span>
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-semibold text-text">{String(vhost["host"] || copy.webNewVhost)}</strong>
                    <small className="mt-1 block truncate text-micro text-text-faint">
                      {String(vhost["public_addr"] || copy.webPublicAddressMissing)} · {copy.webProfileCount.replace("{count}", String(profiles.length))}
                    </small>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="hidden items-center gap-1 sm:flex">
                      <RecordIconButton label={copy.duplicateRecord} onClick={duplicate}><IconCopy className="size-4" /></RecordIconButton>
                      <RecordIconButton label={copy.deleteRecord} danger onClick={remove}><IconTrash className="size-4" /></RecordIconButton>
                    </span>
                    <RecordIconButton label={expanded ? copy.collapseRecord : copy.expandRecord} onClick={() => setExpandedVhosts((current) => expanded ? current.filter((item) => item !== index) : [...current, index])}>
                      {expanded ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
                    </RecordIconButton>
                  </span>
                </header>
                {expanded && (
                  <div className="border-t border-border/70 pb-4 sm:pl-2">
                    <WebVhostFields
                      fieldsByPath={fieldsByPath}
                      sections={sections}
                      vhostIndex={index}
                      vhost={vhost}
                      profiles={profiles}
                      advanced={advanced}
                      onChange={onChange}
                    />
                    <div className="mt-3 flex gap-2 border-t border-border/70 pt-3 sm:hidden">
                      <button type="button" className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-meta font-semibold text-text-muted" onClick={duplicate}>
                        <IconCopy className="size-4" />{copy.duplicateRecord}
                      </button>
                      <button type="button" className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-bad/8 px-3 text-meta font-semibold text-bad" onClick={remove}>
                        <IconTrash className="size-4" />{copy.deleteRecord}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
        <AddRecordButton onClick={() => {
          updateVhosts([...vhosts, newWebVhost()]);
          setExpandedVhosts([vhosts.length]);
        }}>{copy.webAddVhost}</AddRecordButton>
      </section>

      {rootField("web.debug.enabled")}

      {advanced && advancedGroups.map((group) => group.fields.length > 0 && (
        <WebAdvancedSection key={group.id} title={group.title} hint={group.hint} count={group.fields.length}>
          <GenericFields fields={group.fields} sections={sections} advanced onChange={onChange} />
        </WebAdvancedSection>
      ))}
    </div>
  );
}

function WebRequirement({ ready, title, hint }: { ready: boolean; title: string; hint: string }) {
  return (
    <div className={cn("flex min-w-0 gap-2.5 rounded-lg border px-3 py-2.5", ready ? "border-ok/20 bg-ok/[0.045]" : "border-warn/20 bg-warn/[0.045]")}>
      <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold", ready ? "bg-ok text-white" : "bg-warn/15 text-warn")}>{ready ? "✓" : "!"}</span>
      <span className="min-w-0">
        <strong className="block text-meta font-semibold text-text">{title}</strong>
        <small className="mt-0.5 block text-micro leading-relaxed text-text-muted">{hint}</small>
      </span>
    </div>
  );
}

function WebVhostFields({ fieldsByPath, sections, vhostIndex, vhost, profiles, advanced, onChange }: {
  fieldsByPath: Map<string, TelemtConfigField>;
  sections: Record<string, unknown>;
  vhostIndex: number;
  vhost: Record<string, unknown>;
  profiles: Array<Record<string, unknown>>;
  advanced: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const copy = useStrings().server.config.catalog;
  const labels = copy.labels as Record<string, string>;
  const decoy = typeof vhost["decoy"] === "object" && vhost["decoy"] !== null && !Array.isArray(vhost["decoy"])
    ? vhost["decoy"] as Record<string, unknown>
    : {};
  const decoyMode = String(decoy["mode"] ?? "http_upstream");
  const vhostPath = (leaf: string) => `web.vhosts[${vhostIndex}].${leaf}`;
  const textFieldRow = (catalogPath: string, concretePath: string, placeholder: string) => {
    const field = fieldsByPath.get(catalogPath);
    if (!field) return null;
    const label = configFieldLabel(field, labels);
    return (
      <div key={concretePath} className="grid min-h-[74px] gap-2 border-b border-border/75 py-3.5 sm:grid-cols-[minmax(180px,1fr)_minmax(170px,225px)] sm:items-center sm:gap-4">
        <div className="min-w-0">
          <strong className="text-sm font-semibold text-text">{label}</strong>
          <p className="mt-1 text-meta leading-relaxed text-text-muted">{advanced ? configFieldDescription(field, { restart: copy.applyRestart, conditional: copy.applyConditional, reload: copy.applyReload }) : `${copy.currentValue} · ${field.data_type}`}</p>
          {advanced && <code className="mt-1 block break-all font-mono text-micro text-accent/80">{concretePath}</code>}
        </div>
        <Input value={String(getConfigValue(sections, concretePath) ?? "")} placeholder={placeholder} autoCapitalize="off" spellCheck={false} aria-label={label} onChange={(event) => onChange(setConfigValue(sections, concretePath, event.target.value))} />
      </div>
    );
  };

  return (
    <div className="min-w-0">
      {textFieldRow("web.vhosts[].host", vhostPath("host"), "proxy.example.com")}
      {textFieldRow("web.vhosts[].public_addr", vhostPath("public_addr"), "203.0.113.10:443")}

      <div className="py-4">
        <SectionHeading title={copy.webDecoyTitle} hint={copy.webDecoyHint} />
        <div className="mt-3 rounded-xl border border-border bg-bg/25 px-3 sm:px-4">
          <div className="grid min-h-[74px] gap-2 border-b border-border/75 py-3.5 sm:grid-cols-[minmax(180px,1fr)_minmax(170px,225px)] sm:items-center sm:gap-4">
            <div>
              <strong className="text-sm font-semibold text-text">{labels["web.vhosts.decoy.mode"] ?? copy.webDecoyMode}</strong>
              <p className="mt-1 text-meta leading-relaxed text-text-muted">{copy.webDecoyModeHint}</p>
            </div>
            <Select value={decoyMode} aria-label={labels["web.vhosts.decoy.mode"] ?? copy.webDecoyMode} onChange={(event) => onChange(setConfigValue(sections, vhostPath("decoy"), decoyForMode(decoy, event.target.value)))}>
              <option value="http_upstream">{copy.webDecoyHttp}</option>
              <option value="static_directory">{copy.webDecoyStatic}</option>
            </Select>
          </div>
          {decoyMode === "static_directory" ? (
            <>
              {textFieldRow("web.vhosts[].decoy.directory", vhostPath("decoy.directory"), "/var/www/html")}
              {textFieldRow("web.vhosts[].decoy.index", vhostPath("decoy.index"), "index.html")}
            </>
          ) : textFieldRow("web.vhosts[].decoy.upstream", vhostPath("decoy.upstream"), "http://127.0.0.1:8080")}
        </div>
      </div>

      <div className="pt-1">
        <div className="flex items-end justify-between gap-3">
          <SectionHeading title={copy.webProfilesTitle} hint={copy.webProfilesHint} />
          <span className="mb-0.5 shrink-0 rounded-full bg-surface-2 px-2 py-1 text-micro font-semibold text-text-faint">{profiles.length}</span>
        </div>
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-bg/25 p-3.5 sm:flex-row sm:items-center">
          <span className="min-w-0 flex-1">
            <strong className="block text-sm font-semibold text-text">{copy.webProfileCount.replace("{count}", String(profiles.length))}</strong>
            <small className="mt-1 block text-meta leading-relaxed text-text-muted">{profiles.length === 0 ? copy.webNoProfiles : copy.webProfilesManagedInPeople}</small>
          </span>
          <a href="/people" className="flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 px-4 text-meta font-semibold text-accent hover:border-accent/40 hover:bg-accent/[0.05]">
            {copy.webManageProfiles}
          </a>
        </div>
      </div>
    </div>
  );
}

function WebAdvancedSection({ title, hint, count, children }: { title: string; hint: string; count: number; children: ReactNode }) {
  const copy = useStrings().server.config.catalog;
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-border pt-3">
      <button type="button" className="flex min-h-[64px] w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-surface-2" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="min-w-0 flex-1">
          <strong className="block text-sm font-semibold text-text">{title}</strong>
          <small className="mt-1 block text-meta leading-relaxed text-text-muted">{hint}</small>
        </span>
        <span className="rounded-full bg-surface-2 px-2 py-1 text-micro font-semibold text-text-faint">{count}</span>
        {open ? <IconChevronUp className="size-4 text-text-faint" /> : <IconChevronDown className="size-4 text-text-faint" />}
      </button>
      {open && <div className="pl-2">{children}</div>}
      {!open && <span className="sr-only">{copy.expandRecord}</span>}
    </section>
  );
}

function webVhostReady(vhost: Record<string, unknown>): boolean {
  const decoy = typeof vhost["decoy"] === "object" && vhost["decoy"] !== null && !Array.isArray(vhost["decoy"])
    ? vhost["decoy"] as Record<string, unknown>
    : {};
  const mode = String(decoy["mode"] ?? "");
  const decoyReady = mode === "http_upstream"
    ? String(decoy["upstream"] ?? "").trim() !== ""
    : mode === "static_directory" && String(decoy["directory"] ?? "").trim() !== "";
  const profiles = asRecordArray(vhost["profiles"]);
  return String(vhost["host"] ?? "").trim() !== ""
    && String(vhost["public_addr"] ?? "").trim() !== ""
    && decoyReady
    && profiles.length > 0
    && profiles.every((profile) => String(profile["user"] ?? "").trim() !== "");
}

function carrierOrderFromFallback(fallback: string): string[] {
  return [fallback, ...WEB_CARRIERS.filter((carrier) => carrier !== fallback)];
}

function moveArrayItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function cloneConfigRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function decoyForMode(decoy: Record<string, unknown>, mode: string): Record<string, unknown> {
  if (mode === "static_directory") {
    return {
      mode,
      directory: String(decoy["directory"] ?? "/var/www/html"),
      index: String(decoy["index"] ?? "index.html"),
    };
  }
  return {
    mode: "http_upstream",
    upstream: String(decoy["upstream"] ?? "http://127.0.0.1:8080"),
  };
}

function newWebVhost(): Record<string, unknown> {
  return {
    host: "",
    public_addr: "",
    decoy: {
      mode: "http_upstream",
      upstream: "http://127.0.0.1:8080",
    },
    profiles: [],
  };
}
