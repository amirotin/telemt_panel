import { useMemo, useRef, useState, type ReactNode } from "react";
import type {
  TelemtConfigCatalog,
  TelemtConfigField,
  TelemtConfigGroup,
} from "../../lib/api/generated/types.gen";
import { useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Sheet } from "../../ui/Sheet";
import { Toggle } from "../../ui/Toggle";
import {
  IconCheck,
  IconChevronRight,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconPlus,
  IconSearch,
  IconTrash,
} from "../../ui/icons";
import { useIsDesktop } from "../useIsDesktop";
import {
  catalogFieldMatches,
  fieldInstances,
  getConfigValue,
  isConfigSectionPresent,
  setConfigValue,
  type ConfigFieldInstance,
} from "./configCatalog.helpers";
import {
  CONFIG_GROUP_ICONS,
  configFieldDescription,
  configFieldLabel,
} from "./configFieldPresentation";

export type SettingsMode = "normal" | "advanced";

export interface StructuredSettingsFormProps {
  catalog: TelemtConfigCatalog;
  sections: Record<string, unknown>;
  mode: SettingsMode;
  changedCount?: number;
  onChange: (next: Record<string, unknown>) => void;
}

export function StructuredSettingsForm({
  catalog,
  sections,
  mode,
  changedCount = 0,
  onChange,
}: StructuredSettingsFormProps) {
  const copy = useStrings().server.config.catalog;
  const labels = copy.labels as Record<string, string>;
  const isDesktop = useIsDesktop();
  const [selectedGroup, setSelectedGroup] = useState(catalog.groups[0]?.id ?? "routing");
  const [groupSheetOpen, setGroupSheetOpen] = useState(false);
  const [query, setQuery] = useState("");
  const editorRef = useRef<HTMLElement>(null);
  const activeQuery = mode === "advanced" ? query.trim() : "";
  const group = catalog.groups.find((item) => item.id === selectedGroup) ?? catalog.groups[0];

  const groupFields = useMemo(() => {
    const visible = catalog.fields.filter(
      (field) =>
        (activeQuery !== "" || field.group === group?.id) &&
        (mode === "advanced" || field.tier === "normal") &&
        isConfigSectionPresent(sections, field),
    );
    return visible.filter((field) =>
      catalogFieldMatches(field, activeQuery, configFieldLabel(field, labels)),
    );
  }, [activeQuery, catalog.fields, group?.id, labels, mode, sections]);

  if (!group) return null;
  const groupDescription = copy.groups[group.id as keyof typeof copy.groups] ?? "";
  const groupMetric = group.id === "listeners" && activeQuery === ""
    ? copy.listenerCount.replace("{count}", String(asRecordArray(getConfigValue(sections, "server.listeners")).length))
    : group.id === "web" && activeQuery === ""
      ? copy.webVhostCount.replace("{count}", String(asRecordArray(getConfigValue(sections, "web.vhosts")).length))
      : `${groupFields.length} ${mode === "normal" ? copy.normalCount : copy.fieldCount}`;
  const selectGroup = (id: string) => {
    setSelectedGroup(id);
    setQuery("");
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: "start", behavior: "auto" }));
  };

  return (
    <div className="relative grid min-w-0 grid-cols-[minmax(0,1fr)] lg:grid-cols-[225px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_270px]">
      {isDesktop ? (
        <aside className="min-w-0 border-r border-border bg-bg/35 px-2.5 py-3">
          {mode === "advanced" && <SearchField query={query} setQuery={setQuery} />}
          <GroupList
            catalog={catalog}
            sections={sections}
            mode={mode}
            selected={group.id}
            onSelect={selectGroup}
          />
          <div className="mt-4 border-t border-border px-2 pt-3">
            <span className="inline-flex rounded-full bg-ok/10 px-2 py-1 text-micro font-bold text-ok">
              {catalog.version}
            </span>
            <p className="mt-1.5 text-micro leading-relaxed text-text-faint">
              {copy.catalogComplete.replace("{count}", String(catalog.fields.length))}
            </p>
          </div>
        </aside>
      ) : (
        <div className="border-b border-border p-2.5">
          <button
            type="button"
            className="flex min-h-12 w-full items-center gap-2.5 rounded-lg border border-border bg-bg/35 px-3 text-left"
            onClick={() => setGroupSheetOpen(true)}
            aria-haspopup="dialog"
          >
            <span className="text-micro font-bold uppercase tracking-[0.12em] text-text-faint">{copy.sections}</span>
            <strong className="min-w-0 flex-1 truncate text-meta text-text">{group.title}</strong>
            <IconChevronRight className="size-4 text-text-faint" />
          </button>
          {mode === "advanced" && <div className="mt-2"><SearchField query={query} setQuery={setQuery} /></div>}
        </div>
      )}

      <main ref={editorRef} className="min-w-0 scroll-mt-3 px-3 pb-20 pt-4 sm:px-5 lg:min-h-[660px] xl:border-r xl:border-border">
        <header className="flex min-h-[64px] items-start justify-between gap-4 border-b border-border pb-3.5">
          <div className="min-w-0">
            <p className="mb-1 text-micro font-bold uppercase tracking-[0.12em] text-accent">
              {mode === "normal" ? copy.normalMode : copy.advancedMode}
            </p>
            <h2 className="text-xl font-bold tracking-tight text-text">{activeQuery ? copy.searchResults : group.title}</h2>
            <p className="mt-1 max-w-2xl text-meta leading-relaxed text-text-muted">
              {activeQuery ? copy.searchDescription : groupDescription}
            </p>
          </div>
          <span className="hidden shrink-0 rounded-full bg-accent/10 px-2.5 py-1 text-micro font-bold text-accent sm:inline-flex">
            {groupMetric}
          </span>
        </header>

        {groupFields.length === 0 ? (
          <EmptyFields />
        ) : activeQuery ? (
          <GenericFields fields={groupFields} sections={sections} advanced catalog={catalog} onChange={onChange} />
        ) : group.id === "routing" ? (
          <RoutingEditor fields={groupFields} sections={sections} advanced={mode === "advanced"} catalog={catalog} onChange={onChange} />
        ) : group.id === "me" ? (
          <MeEditor fields={groupFields} sections={sections} advanced={mode === "advanced"} catalog={catalog} onChange={onChange} />
        ) : group.id === "upstreams" ? (
          <UpstreamsEditor fields={groupFields} sections={sections} advanced={mode === "advanced"} onChange={onChange} />
        ) : group.id === "tls" ? (
          <TlsEditor fields={groupFields} sections={sections} advanced={mode === "advanced"} onChange={onChange} />
        ) : group.id === "listeners" ? (
          <ListenersEditor fields={groupFields} sections={sections} advanced={mode === "advanced"} onChange={onChange} />
        ) : group.id === "web" ? (
          <WebEditor fields={groupFields} sections={sections} advanced={mode === "advanced"} onChange={onChange} />
        ) : (
          <GenericFields fields={groupFields} sections={sections} advanced={mode === "advanced"} onChange={onChange} />
        )}
      </main>

      <ConfigInspector changedCount={changedCount} />

      <Sheet
        open={!isDesktop && groupSheetOpen}
        onClose={() => setGroupSheetOpen(false)}
        title={copy.groupDialogTitle}
        subtitle={mode === "normal" ? copy.normalSubtitle : copy.advancedSubtitle}
        placement="bottom"
      >
        <GroupList
          catalog={catalog}
          sections={sections}
          mode={mode}
          selected={group.id}
          onSelect={(id) => {
            selectGroup(id);
            setGroupSheetOpen(false);
          }}
        />
      </Sheet>
    </div>
  );
}

function SearchField({ query, setQuery }: { query: string; setQuery: (value: string) => void }) {
  const copy = useStrings().server.config.catalog;
  return (
    <label className="relative mb-2 block">
      <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-text-faint" />
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={copy.searchPlaceholder}
        className="h-10 pl-9 text-meta"
        aria-label={copy.searchLabel}
      />
    </label>
  );
}

function GroupList({
  catalog,
  sections,
  mode,
  selected,
  onSelect,
}: {
  catalog: TelemtConfigCatalog;
  sections: Record<string, unknown>;
  mode: SettingsMode;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const copy = useStrings().server.config.catalog;
  return (
    <div className="flex flex-col gap-1">
      {catalog.groups.map((group) => {
        const count = catalog.fields.filter(
          (field) =>
            field.group === group.id &&
            (mode === "advanced" || field.tier === "normal") &&
            isConfigSectionPresent(sections, field),
        ).length;
        return (
          <button
            key={group.id}
            type="button"
            className={cn(
              "group flex min-h-[52px] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
              selected === group.id ? "bg-accent/12 text-text" : "text-text-muted hover:bg-surface-2 hover:text-text",
            )}
            onClick={() => onSelect(group.id)}
            aria-current={selected === group.id ? "page" : undefined}
          >
            <GroupIcon group={group} />
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-meta font-semibold">{group.short}</strong>
              <span className="mt-0.5 block text-micro text-text-faint">
                {count} {mode === "normal" ? copy.normalCount : copy.fieldCount}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function GroupIcon({ group }: { group: TelemtConfigGroup }) {
  const Icon = CONFIG_GROUP_ICONS[group.id];
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-accent" aria-hidden="true">
      {Icon ? <Icon className="size-[17px]" /> : group.short.slice(0, 1)}
    </span>
  );
}

function GenericFields({ fields, sections, advanced, catalog, onChange }: {
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

const ROUTING_MODE_PATHS = [
  "general.modes.classic",
  "general.modes.secure",
  "general.modes.tls",
] as const;

const ROUTING_PRIMARY_PATHS = new Set<string>([
  ...ROUTING_MODE_PATHS,
  "general.use_middle_proxy",
  "general.me2dc_fallback",
  "general.fast_mode",
]);

function RoutingEditor({ fields, sections, advanced, catalog, onChange }: {
  fields: TelemtConfigField[];
  sections: Record<string, unknown>;
  advanced: boolean;
  catalog: TelemtConfigCatalog;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const copy = useStrings().server.config.catalog;
  const labels = copy.labels as Record<string, string>;
  const [modeNotice, setModeNotice] = useState("");
  const fieldsByPath = new Map(fields.map((field) => [field.path, field]));
  const modeFields = ROUTING_MODE_PATHS.flatMap((path) => {
    const field = fieldsByPath.get(path);
    return field ? [field] : [];
  });
  const enabledModes = modeFields.filter((field) => getConfigValue(sections, field.path) === true).length;
  const useMeField = fieldsByPath.get("general.use_middle_proxy");
  const fallbackField = fieldsByPath.get("general.me2dc_fallback");
  const fastModeField = fieldsByPath.get("general.fast_mode");
  const useMe = getConfigValue(sections, "general.use_middle_proxy") === true;
  const additionalFields = fields.filter((field) => !ROUTING_PRIMARY_PATHS.has(field.path));
  const update = (path: string, value: unknown) => onChange(setConfigValue(sections, path, value));
  const modeHint = (path: string) => {
    if (path.endsWith("classic")) return copy.clientModeClassicHint;
    if (path.endsWith("secure")) return copy.clientModeSecureHint;
    return copy.clientModeTlsHint;
  };

  return (
    <div className="min-w-0 space-y-5 py-4">
      <RestartNotice>{copy.routingRestartHint}</RestartNotice>

      {modeFields.length > 0 && (
        <section>
          <div className="mb-3">
            <h3 className="text-sm font-bold text-text">{copy.clientModesTitle}</h3>
            <p className="mt-1 text-meta leading-relaxed text-text-muted">{copy.clientModesHint}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {modeFields.map((field) => {
              const checked = getConfigValue(sections, field.path) === true;
              const isLast = checked && enabledModes === 1;
              return (
                <button
                  key={field.path}
                  type="button"
                  aria-pressed={checked}
                  className={cn(
                    "min-h-[86px] rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                    checked ? "border-accent/45 bg-accent/8" : "border-border bg-bg/30 hover:bg-surface-2",
                  )}
                  onClick={() => {
                    if (isLast) {
                      setModeNotice(copy.clientModeRequired);
                      return;
                    }
                    setModeNotice("");
                    update(field.path, !checked);
                  }}
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="text-sm text-text">{configFieldLabel(field, labels)}</strong>
                    <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border", checked ? "border-accent bg-accent text-white" : "border-border bg-surface-2 text-transparent")}>
                      <IconCheck className="size-3.5" />
                    </span>
                  </span>
                  <span className="mt-2 block text-meta leading-snug text-text-muted">{modeHint(field.path)}</span>
                </button>
              );
            })}
          </div>
          <p className={cn("mt-2 min-h-4 text-micro", modeNotice ? "text-warn" : "text-text-faint")} aria-live="polite">
            {modeNotice}
          </p>
        </section>
      )}

      {(useMeField || fallbackField || fastModeField) && (
        <section>
          <div className="mb-3">
            <h3 className="text-sm font-bold text-text">{copy.routeTitle}</h3>
            <p className="mt-1 text-meta leading-relaxed text-text-muted">{copy.routeHint}</p>
          </div>
          {useMeField && (
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-1.5" role="radiogroup" aria-label={copy.routeTitle}>
              <RouteChoice active={useMe} title={copy.routeMe} hint={copy.routeMeHint} onClick={() => update(useMeField.path, true)} />
              <RouteChoice active={!useMe} title={copy.routeDirect} hint={copy.routeDirectHint} onClick={() => update(useMeField.path, false)} />
            </div>
          )}
          <div className="mt-2 divide-y divide-border/75 rounded-xl border border-border bg-bg/25 px-3 sm:px-4">
            {fallbackField && (
              <RoutingToggleRow
                label={configFieldLabel(fallbackField, labels)}
                hint={useMe ? copy.fallbackHint : copy.fallbackInactive}
                checked={getConfigValue(sections, fallbackField.path) === true}
                disabled={!useMe}
                onChange={(value) => update(fallbackField.path, value)}
              />
            )}
            {fastModeField && (
              <RoutingToggleRow
                label={configFieldLabel(fastModeField, labels)}
                hint={copy.fastModeHint}
                checked={getConfigValue(sections, fastModeField.path) === true}
                onChange={(value) => update(fastModeField.path, value)}
              />
            )}
          </div>
        </section>
      )}

      {additionalFields.length > 0 && (
        <section className="border-t border-border pt-2">
          <h3 className="py-3 text-sm font-bold text-text">{copy.technicalRouting}</h3>
          <GenericFields fields={additionalFields} sections={sections} advanced={advanced} catalog={catalog} onChange={onChange} />
        </section>
      )}
    </div>
  );
}

function RouteChoice({ active, title, hint, onClick }: { active: boolean; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={cn(
        "min-h-[68px] rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        active ? "border-accent/40 bg-surface shadow-sm" : "border-transparent text-text-muted hover:bg-surface/60",
      )}
      onClick={onClick}
    >
      <span className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", active ? "bg-ok" : "bg-text-faint/40")} />
        <strong className="text-sm text-text">{title}</strong>
      </span>
      <span className="mt-1 block pl-4 text-meta leading-snug text-text-muted">{hint}</span>
    </button>
  );
}

function RoutingToggleRow({ label, hint, checked, disabled = false, onChange }: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={cn("flex min-h-[72px] w-full min-w-0 items-center gap-4 py-3", disabled && "opacity-65")}>
      <div className="min-w-0 flex-1">
        <strong className="text-sm font-semibold text-text">{label}</strong>
        <p className="mt-1 text-meta leading-snug text-text-muted">{hint}</p>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />
    </div>
  );
}

const ME_PRIMARY_PATHS = new Set<string>([
  "general.hardswap",
  "general.middle_proxy_nat_probe",
  "general.middle_proxy_pool_size",
  "general.middle_proxy_warm_standby",
]);

function MeEditor({ fields, sections, advanced, catalog, onChange }: {
  fields: TelemtConfigField[];
  sections: Record<string, unknown>;
  advanced: boolean;
  catalog: TelemtConfigCatalog;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const copy = useStrings().server.config.catalog;
  const labels = copy.labels as Record<string, string>;
  const fieldsByPath = new Map(fields.map((field) => [field.path, field]));
  const natProbeField = fieldsByPath.get("general.middle_proxy_nat_probe");
  const poolSizeField = fieldsByPath.get("general.middle_proxy_pool_size");
  const warmStandbyField = fieldsByPath.get("general.middle_proxy_warm_standby");
  const hardswapField = fieldsByPath.get("general.hardswap");
  const useMe = getConfigValue(sections, "general.use_middle_proxy") === true;
  const additionalFields = fields.filter((field) => !ME_PRIMARY_PATHS.has(field.path));
  const update = (path: string, value: unknown) => onChange(setConfigValue(sections, path, value));

  return (
    <div className="min-w-0 space-y-5 py-4">
      {!useMe && (
        <div className="border-l-2 border-warn bg-warn/5 px-3 py-2.5">
          <strong className="block text-meta text-text">{copy.meDisabledTitle}</strong>
          <p className="mt-1 text-meta leading-relaxed text-text-muted">{copy.meDisabledHint}</p>
        </div>
      )}

      {natProbeField && (
        <section className="min-w-0">
          <SectionHeading title={copy.meNatTitle} hint={copy.meNatHint} restart={copy.restartRequired} />
          <div className="border-y border-border px-1 sm:px-2">
            <RoutingToggleRow
              label={configFieldLabel(natProbeField, labels)}
              hint={copy.meNatProbeHint}
              checked={getConfigValue(sections, natProbeField.path) === true}
              onChange={(value) => update(natProbeField.path, value)}
            />
          </div>
        </section>
      )}

      {(poolSizeField || warmStandbyField) && (
        <section className="min-w-0">
          <SectionHeading title={copy.meCapacityTitle} hint={copy.meCapacityHint} restart={copy.restartRequired} />
          <div className="divide-y divide-border/75 border-y border-border px-1 sm:px-2">
            {poolSizeField && (
              <MeNumberRow
                field={poolSizeField}
                label={configFieldLabel(poolSizeField, labels)}
                hint={copy.mePoolSizeHint}
                unit={copy.meConnectionsUnit}
                value={getConfigValue(sections, poolSizeField.path)}
                onChange={(value) => update(poolSizeField.path, value)}
              />
            )}
            {warmStandbyField && (
              <MeNumberRow
                field={warmStandbyField}
                label={configFieldLabel(warmStandbyField, labels)}
                hint={copy.meWarmStandbyHint}
                unit={copy.meConnectionsUnit}
                value={getConfigValue(sections, warmStandbyField.path)}
                onChange={(value) => update(warmStandbyField.path, value)}
              />
            )}
          </div>
        </section>
      )}

      {hardswapField && (
        <section className="min-w-0">
          <SectionHeading title={configFieldLabel(hardswapField, labels)} hint={copy.meHardswapHint} />
          <div className="border-y border-border px-1 sm:px-2">
            <RoutingToggleRow
              label={copy.meHardswapToggle}
              hint={copy.meHardswapApply}
              checked={getConfigValue(sections, hardswapField.path) === true}
              onChange={(value) => update(hardswapField.path, value)}
            />
          </div>
        </section>
      )}

      {additionalFields.length > 0 && (
        <section className="border-t border-border pt-2">
          <h3 className="py-3 text-sm font-bold text-text">{copy.technicalMe}</h3>
          <GenericFields fields={additionalFields} sections={sections} advanced={advanced} catalog={catalog} onChange={onChange} />
        </section>
      )}
    </div>
  );
}

function SectionHeading({ title, hint, restart }: { title: string; hint: string; restart?: string }) {
  return (
    <div className="mb-3 flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-bold text-text">{title}</h3>
        <p className="mt-1 text-meta leading-relaxed text-text-muted">{hint}</p>
      </div>
      {restart && <span className="shrink-0 rounded-full bg-warn/10 px-2 py-1 text-micro font-bold text-warn">{restart}</span>}
    </div>
  );
}

function RestartNotice({ children }: { children: ReactNode }) {
  const copy = useStrings().server.config.catalog;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-3 text-meta text-text-muted">
      <span className="rounded-full bg-warn/10 px-2 py-1 text-micro font-bold text-warn">{copy.restartRequired}</span>
      <span>{children}</span>
    </div>
  );
}

function MeNumberRow({ field, label, hint, unit, value, onChange }: {
  field: TelemtConfigField;
  label: string;
  hint: string;
  unit: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <div className="grid min-h-[78px] gap-3 py-3.5 sm:grid-cols-[minmax(0,1fr)_150px] sm:items-center">
      <div className="min-w-0">
        <strong className="text-sm font-semibold text-text">{label}</strong>
        <p className="mt-1 text-meta leading-snug text-text-muted">{hint}</p>
      </div>
      <div>
        <FieldControl field={field} value={value} label={label} onChange={onChange} />
        <span className="mt-1 block text-right text-micro text-text-faint">{unit}</span>
      </div>
    </div>
  );
}

function UpstreamsEditor({ fields, sections, advanced, onChange }: {
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

function TlsEditor({ fields, sections, advanced, onChange }: {
  fields: TelemtConfigField[];
  sections: Record<string, unknown>;
  advanced: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const copy = useStrings().server.config.catalog;
  const specialized = new Set(["censorship.tls_domains", "censorship.exclusive_mask"]);
  const ordinaryFields = fields.filter((field) => !specialized.has(field.path));
  const rawDomains = getConfigValue(sections, "censorship.tls_domains");
  const tlsDomains = Array.isArray(rawDomains) ? rawDomains.map(String) : [];
  const maskMap = asStringMap(getConfigValue(sections, "censorship.exclusive_mask"));
  const maskEntries = Object.entries(maskMap);

  return (
    <div>
      <GenericFields fields={ordinaryFields} sections={sections} advanced={advanced} onChange={onChange} />

      {fields.some((field) => field.path === "censorship.tls_domains") && (
        <Subsection title={copy.additionalTlsDomains} count={tlsDomains.length}>
          <RecordListEmpty show={tlsDomains.length === 0}>{copy.noAdditionalDomains}</RecordListEmpty>
          {tlsDomains.map((domain, index) => (
            <div key={index} className="grid min-h-[62px] grid-cols-[minmax(0,1fr)_44px] items-center gap-2 border-b border-border py-2 first:border-t">
              <Input
                value={domain}
                placeholder="cdn.example.com"
                aria-label={`${copy.tlsDomain} ${index + 1}`}
                onChange={(event) => {
                  const next = [...tlsDomains];
                  next[index] = event.target.value;
                  onChange(setConfigValue(sections, "censorship.tls_domains", next));
                }}
              />
              <RecordIconButton label={copy.deleteRecord} danger onClick={() => onChange(setConfigValue(sections, "censorship.tls_domains", tlsDomains.filter((_, itemIndex) => itemIndex !== index)))}>
                <IconTrash className="size-4" />
              </RecordIconButton>
            </div>
          ))}
          <AddRecordButton onClick={() => onChange(setConfigValue(sections, "censorship.tls_domains", [...tlsDomains, ""]))}>{copy.addTlsDomain}</AddRecordButton>
        </Subsection>
      )}

      {fields.some((field) => field.path === "censorship.exclusive_mask") && (
        <Subsection title={copy.exclusiveMasks} count={maskEntries.length}>
          <p className="mb-3 text-meta leading-relaxed text-text-muted">{copy.exclusiveMasksHint}</p>
          <RecordListEmpty show={maskEntries.length === 0}>{copy.noExclusiveMasks}</RecordListEmpty>
          {maskEntries.map(([domain, target], index) => (
            <section key={`${domain}-${index}`} className="border-b border-border py-3 first:border-t">
              <div className="mb-2 flex items-center justify-between gap-2">
                <strong className="text-meta font-semibold text-text">{copy.maskRule} {index + 1}</strong>
                <RecordIconButton
                  label={copy.deleteRecord}
                  danger
                  onClick={() => onChange(setConfigValue(sections, "censorship.exclusive_mask", Object.fromEntries(maskEntries.filter((_, itemIndex) => itemIndex !== index))))}
                >
                  <IconTrash className="size-4" />
                </RecordIconButton>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label>
                  <span className="mb-1 block text-micro font-semibold text-text-muted">{copy.sniDomain}</span>
                  <Input
                    value={domain}
                    placeholder="bsi.bund.de"
                    aria-label={`${copy.sniDomain} ${index + 1}`}
                    onChange={(event) => {
                      const nextEntries = [...maskEntries];
                      nextEntries[index] = [event.target.value, target];
                      onChange(setConfigValue(sections, "censorship.exclusive_mask", Object.fromEntries(nextEntries)));
                    }}
                  />
                </label>
                <label>
                  <span className="mb-1 block text-micro font-semibold text-text-muted">{copy.maskTarget}</span>
                  <Input
                    value={target}
                    placeholder="127.0.0.1:443"
                    aria-label={`${copy.maskTarget} ${index + 1}`}
                    onChange={(event) => {
                      const nextEntries = [...maskEntries];
                      nextEntries[index] = [domain, event.target.value];
                      onChange(setConfigValue(sections, "censorship.exclusive_mask", Object.fromEntries(nextEntries)));
                    }}
                  />
                </label>
              </div>
            </section>
          ))}
          <AddRecordButton disabled={Object.hasOwn(maskMap, "")} onClick={() => onChange(setConfigValue(sections, "censorship.exclusive_mask", { ...maskMap, "": "" }))}>
            {copy.addMaskRule}
          </AddRecordButton>
        </Subsection>
      )}
    </div>
  );
}

const WEB_CARRIERS = ["https", "https-lanes", "websocket", "websocket-lanes"] as const;
const WEB_STRUCTURE_PATHS = new Set([
  "web.debug",
  "web.limits",
  "web.timeouts",
  "web.vhosts",
  "web.vhosts[].decoy",
  "web.vhosts[].profiles",
]);

function WebEditor({ fields, sections, advanced, onChange }: {
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

function ListenersEditor({ fields, sections, advanced, onChange }: {
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

function Subsection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="mt-7 border-t border-border pt-4">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-text">{title}</h3>
        <span className="rounded-full bg-surface-2 px-2 py-1 text-micro font-semibold text-text-faint">{count}</span>
      </header>
      {children}
    </section>
  );
}

function AddRecordButton({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong text-meta font-semibold text-accent hover:bg-accent/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
      onClick={onClick}
    >
      <IconPlus className="size-4" />
      {children}
    </button>
  );
}

function RecordListEmpty({ show, children }: { show: boolean; children: ReactNode }) {
  return show ? <p className="border-y border-border py-5 text-center text-meta text-text-muted">{children}</p> : null;
}

function RecordIconButton({ label, danger = false, disabled = false, onClick, children }: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn("grid size-11 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-30", danger && "hover:bg-bad/10 hover:text-bad")}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ConfigInspector({ changedCount }: { changedCount: number }) {
  const copy = useStrings().server.config.catalog;
  return (
    <aside className="min-w-0 border-t border-border bg-bg/25 px-4 pb-20 pt-4 lg:col-start-2 xl:col-start-auto xl:border-t-0">
      <header className="flex min-h-8 items-center justify-between border-b border-border pb-2.5">
        <strong className="text-meta text-text">{copy.changes}</strong>
        <span className={cn("rounded-full px-2 py-0.5 text-micro font-bold", changedCount > 0 ? "bg-warn/10 text-warn" : "bg-surface-2 text-text-faint")}>{changedCount}</span>
      </header>
      <div className="grid min-h-[210px] place-items-center text-center">
        <div className="max-w-[190px]">
          <i className={cn("mx-auto mb-3 grid size-11 place-items-center rounded-xl border not-italic", changedCount > 0 ? "border-warn/30 bg-warn/5 text-warn" : "border-border bg-ok/5 text-ok")}>
            {changedCount > 0 ? changedCount : "✓"}
          </i>
          <strong className="block text-meta text-text-muted">{changedCount > 0 ? copy.draftChanged : copy.configSynchronized}</strong>
          <span className="mt-1.5 block text-micro leading-relaxed text-text-faint">{changedCount > 0 ? copy.draftChangedHint : copy.configSynchronizedHint}</span>
        </div>
      </div>
    </aside>
  );
}

function EmptyFields() {
  const copy = useStrings().server.config.catalog;
  return <div className="py-12 text-center"><p className="text-sm font-semibold text-text">{copy.emptyTitle}</p><p className="mt-1 text-meta text-text-muted">{copy.emptyDescription}</p></div>;
}

function ConfigFieldRow({ instance, advanced, groupName, onChange }: {
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

function FieldControl({ field, value, label, onChange }: { field: TelemtConfigField; value: unknown; label: string; onChange: (value: unknown) => void }) {
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

function pathLeaf(path: string): string {
  return path.split(".").at(-1)?.replace("[]", "") ?? path;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

function asStringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
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
