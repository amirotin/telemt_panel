import { useMemo, useRef, useState } from "react";
import type { TelemtConfigCatalog, TelemtConfigGroup } from "../../lib/api/generated/types.gen";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { Input } from "../../ui/Input";
import { Sheet } from "../../ui/Sheet";
import { IconChevronRight, IconSearch } from "../../ui/icons";
import { useIsDesktop } from "../useIsDesktop";
import { catalogFieldMatches, getConfigValue, isConfigSectionPresent } from "./configCatalog.helpers";
import { CONFIG_GROUP_ICONS, configFieldLabel } from "./configFieldPresentation";
import { RoutingEditor } from "./RoutingEditor";
import { MeEditor } from "./MeEditor";
import { UpstreamsEditor } from "./UpstreamsEditor";
import { TlsEditor } from "./TlsEditor";
import { WebEditor } from "./WebEditor";
import { ListenersEditor } from "./ListenersEditor";
import { GenericFields } from "./ConfigFieldControls";
import { asRecordArray } from "./configRecords";

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
        (isConfigSectionPresent(sections, field) ||
          field.group === "upstreams" ||
          field.group === "web"),
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

      <section ref={editorRef} className="min-w-0 scroll-mt-3 px-3 pb-20 pt-4 sm:px-5 lg:min-h-[660px] xl:border-r xl:border-border">
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
      </section>

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
