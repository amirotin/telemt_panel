import { cn } from "../../lib/cn";
import { ru, errorMessage } from "../../i18n/ru";
import { Skeleton } from "../../ui/Skeleton";
import { StatePill } from "../../ui/StatePill";
import { reloadStepInfo, type ReloadState } from "./reloadStatus.helpers";
import type { ReloadStatus } from "../../lib/api/generated/types.gen";

const HAPPY_STEPS: ReloadState[] = ["accepted", "preparing", "activating", "draining", "succeeded"];

// ReloadStepper — the compact live progress bar for a config reload
// (07-telemt-sdk.md: accepted→preparing→activating→draining→succeeded, or
// rolled_back/failed as an alternate terminal outcome), fed by
// useReloadPolling.
export function ReloadStepper({ status, errorCode }: { status: ReloadStatus | null | undefined; errorCode?: string }) {
  if (errorCode) return <p className="text-sm text-error">{errorMessage(errorCode)}</p>;
  if (!status) return <Skeleton className="h-6 w-full" />;

  const info = reloadStepInfo(status.state);

  if (info.outcome === "error") {
    return (
      <div className="flex flex-col gap-1">
        <StatePill state="error">{ru.server.config.reload.states[status.state]}</StatePill>
        {status.error && <p className="text-xs text-text-muted">{status.error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2" aria-label={ru.server.config.reload.title}>
      <div className="flex flex-1 gap-1" role="list">
        {HAPPY_STEPS.map((step, i) => (
          <span
            key={step}
            role="listitem"
            title={ru.server.config.reload.states[step]}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i <= info.stepIndex ? (info.outcome === "success" ? "bg-ok" : "bg-accent") : "bg-surface-3",
            )}
          />
        ))}
      </div>
      <span className="shrink-0 text-xs text-text-muted">{ru.server.config.reload.states[status.state]}</span>
    </div>
  );
}
