import type { TelemtConfigField } from "../../lib/api/generated/types.gen";
import { useStrings } from "../../i18n";
import { Input } from "../../ui/Input";
import { IconTrash } from "../../ui/icons";
import { getConfigValue, setConfigValue } from "./configCatalog.helpers";
import { Subsection, AddRecordButton, RecordListEmpty, RecordIconButton } from "./ConfigEditorControls";
import { GenericFields } from "./ConfigFieldControls";

export function TlsEditor({ fields, sections, advanced, onChange }: {
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

function asStringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}
