import { useState, type ReactNode } from "react";
import type { TelemtConfigCatalog, TelemtConfigField } from "../../lib/api/generated/types.gen";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { IconCheck } from "../../ui/icons";
import { getConfigValue, setConfigValue } from "./configCatalog.helpers";
import { configFieldLabel } from "./configFieldPresentation";
import { RouteChoice, RoutingToggleRow } from "./ConfigEditorControls";
import { GenericFields } from "./ConfigFieldControls";

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

export function RoutingEditor({ fields, sections, advanced, catalog, onChange }: {
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

function RestartNotice({ children }: { children: ReactNode }) {
  const copy = useStrings().server.config.catalog;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-3 text-meta text-text-muted">
      <span className="rounded-full bg-warn/10 px-2 py-1 text-micro font-bold text-warn">{copy.restartRequired}</span>
      <span>{children}</span>
    </div>
  );
}
