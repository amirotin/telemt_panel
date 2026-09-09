import type { TelemtConfigCatalog, TelemtConfigField } from "../../lib/api/generated/types.gen";
import { useStrings } from "../../i18n";
import { getConfigValue, setConfigValue } from "./configCatalog.helpers";
import { configFieldLabel } from "./configFieldPresentation";
import { RoutingToggleRow, SectionHeading } from "./ConfigEditorControls";
import { GenericFields, FieldControl } from "./ConfigFieldControls";

const ME_PRIMARY_PATHS = new Set<string>([
  "general.hardswap",
  "general.middle_proxy_nat_probe",
  "general.middle_proxy_pool_size",
  "general.middle_proxy_warm_standby",
]);

export function MeEditor({ fields, sections, advanced, catalog, onChange }: {
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
