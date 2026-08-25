import { ru } from "../../i18n/ru";
import { Button } from "../../ui/Button";
import type { TelemtConfigPatchResult } from "../../lib/api/generated/types.gen";

export interface PatchResultNoticeProps {
  result: TelemtConfigPatchResult;
  canRestartTelemt: boolean;
  onReloadNow: () => void;
  onRestartNow: () => void;
  reloadPending: boolean;
  restartPending: boolean;
}

// PatchResultNotice renders PATCH /api/telemt/config's own response
// summary (07-telemt-sdk.md: `{changed, runtime_reload_required,
// process_restart_required, deferred_process_fields, reload?}`) — what
// actually changed, and the two follow-up actions the admin might still
// need: reload now (config was changed but no inline reload ran) and
// restart Telemt (some fields only take effect after a process restart).
export function PatchResultNotice({
  result,
  canRestartTelemt,
  onReloadNow,
  onRestartNow,
  reloadPending,
  restartPending,
}: PatchResultNoticeProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-ok/30 bg-ok/5 p-4">
      <p className="text-sm font-medium text-ok">{ru.server.config.saved}</p>
      {result.changed.length > 0 && (
        <div>
          <p className="text-xs text-text-faint">{ru.server.config.changedTitle}</p>
          <p className="text-sm text-text">{result.changed.join(", ")}</p>
        </div>
      )}
      {result.runtime_reload_required && !result.reload && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-warn">{ru.server.config.runtimeReloadNotice}</p>
          <Button variant="secondary" onClick={onReloadNow} disabled={reloadPending}>
            {ru.server.config.reloadNow}
          </Button>
        </div>
      )}
      {result.process_restart_required && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-warn">
            {ru.server.config.processRestartNotice} {(result.deferred_process_fields ?? []).join(", ")}
          </p>
          <Button
            variant="secondary"
            disabled={!canRestartTelemt || restartPending}
            onClick={onRestartNow}
            className="self-start"
          >
            {ru.server.config.restartNow}
          </Button>
        </div>
      )}
    </div>
  );
}
