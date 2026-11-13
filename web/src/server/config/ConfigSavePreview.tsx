import { ConfigNormalizationEffects } from "./ConfigNormalizationEffects";
import type { ConfigPreflight } from "./configPreflight";
import { errorMessage } from "../../i18n";
import type { TelemtConfigCatalog } from "../../lib/api/generated/types.gen";
import { countLabel, useStrings, type Dict } from "../../i18n";
import { Button } from "../../ui/Button";
import { Notice } from "../Notice";
import { Sheet } from "../../ui/Sheet";
import type { ReloadPolicyState } from "./reloadPolicy";
import { configChangeEntries } from "./configChangePreview.helpers";

export function ConfigSavePreview({
  open,
  baseline,
  draft,
  catalog,
  reloadPolicy,
  pending,
  checking = false,
  preflight,
  preflightError,
  readOnly = false,
  onRetry,
  onClose,
  onConfirm,
}: {
  open: boolean;
  baseline: Record<string, unknown>;
  draft: Record<string, unknown>;
  catalog: TelemtConfigCatalog;
  reloadPolicy: ReloadPolicyState;
  pending: boolean;
  checking?: boolean;
  preflight?: ConfigPreflight;
  preflightError?: { code?: string; message?: string; details?: { path: string; message: string }[] } | null;
  readOnly?: boolean;
  onRetry?: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const s = useStrings();
  const copy = s.server.config.savePreview;
  const changes = configChangeEntries(baseline, draft, catalog);
  const arrays = changes.filter((change) => change.arrayReplacement);
  const restart = changes.filter((change) => change.field?.apply.includes("restart"));

  return (
    <Sheet
      open={open}
      onClose={pending ? () => undefined : onClose}
      eyebrow={copy.kicker}
      title={copy.title}
      subtitle={`${countLabel(s, changes.length, [copy.changeOne, copy.changeFew, copy.changeMany])} · ${reloadLabel(reloadPolicy, copy)}`}
      placement="form"
      bodyClassName="flex flex-col gap-3"
    >
      {checking ? <p role="status" className="text-meta text-text-muted">{s.server.config.native.validating}</p> : preflightError ? <Notice tone="error" title={errorMessage(s, preflightError.code ?? "telemt_api_error", preflightError.message)}>
        {preflightError.details?.map((issue, index) => <p key={index} className="break-words text-meta">{issue.path}: {issue.message}</p>)}
        <Button variant="secondary" onClick={onRetry}>{s.server.config.native.retry}</Button>
      </Notice> : preflight && <Notice tone="info" title={preflight.validation ? s.server.config.native.validated : s.server.config.native.legacy}>
        {preflight.validation?.apply.watcher_paths.length ? <p className="text-meta">{s.server.config.native.watcher}</p> : null}
        {preflight.validation && <ConfigNormalizationEffects effects={preflight.validation.normalization_effects} />}
        {preflight.validation?.warnings.map((issue, index) => <p key={index} className="break-words text-meta">{issue.path}: {issue.message}</p>)}
      </Notice>}
      {readOnly && <p className="text-meta text-warn">{s.server.config.native.readonly}</p>}
      {arrays.length > 0 && (
        <Notice tone="warn" title={copy.arraysTitle}>
          <p className="text-meta text-text-muted">{arrays.map((change) => change.path).join(", ")}</p>
        </Notice>
      )}
      {restart.length > 0 && (
        <Notice tone="warn" title={copy.restartTitle}>
          <p className="text-meta text-text-muted">{copy.restartDetail}</p>
        </Notice>
      )}

      <div className="overflow-hidden rounded-xl border border-border">
        {changes.map((change) => (
          <div key={change.path} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <code className="block break-all font-mono text-micro text-accent">{change.path}</code>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2 text-meta">
              <Value value={change.before} secret={change.field?.secret === true} copy={copy} />
              <span className="text-text-faint" aria-hidden="true">→</span>
              <Value value={change.after} secret={change.field?.secret === true} copy={copy} />
            </div>
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 mt-auto flex justify-end gap-2 border-t border-border bg-surface pt-3 pb-safe">
        <Button variant="secondary" onClick={onClose} disabled={pending}>{copy.cancel}</Button>
        <Button onClick={onConfirm} disabled={pending || checking || !!preflightError || !preflight || readOnly || changes.length === 0}>
          {pending ? copy.applying : copy.apply.replace("{count}", String(changes.length))}
        </Button>
      </div>
    </Sheet>
  );
}

function Value({
  value,
  secret,
  copy,
}: {
  value: unknown;
  secret: boolean;
  copy: Dict["server"]["config"]["savePreview"];
}) {
  const formatted = secret && value ? "••••••••" : formatValue(value, copy);
  return <span className="min-w-0 break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-micro text-text-muted">{formatted}</span>;
}

function formatValue(value: unknown, copy: Dict["server"]["config"]["savePreview"]): string {
  if (value === undefined) return copy.unset;
  if (typeof value === "string") return value === "" ? copy.emptyString : value;
  return JSON.stringify(value);
}

function reloadLabel(
  policy: ReloadPolicyState,
  copy: Dict["server"]["config"]["savePreview"],
): string {
  if (policy.mode === "none") return copy.noReload;
  if (policy.mode === "instant") return copy.instantReload;
  return copy.drainReload;
}
