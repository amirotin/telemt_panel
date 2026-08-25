import { errorMessage, useStrings } from "../../i18n";
import { Skeleton } from "../../ui/Skeleton";
import { StatePill } from "../../ui/StatePill";
import { PhaseSteps, type PhaseStep } from "../PhaseSteps";
import { reloadStepInfo, type ReloadState } from "./reloadStatus.helpers";
import type { ReloadStatus } from "../../lib/api/generated/types.gen";

const HAPPY_STEPS: ReloadState[] = [
  "accepted",
  "preparing",
  "activating",
  "draining",
  "succeeded",
];

// ReloadStepper — the compact live progress bar for a config reload
// (07-telemt-sdk.md: accepted→preparing→activating→draining→succeeded, or
// rolled_back/failed as an alternate terminal outcome), fed by
// useReloadPolling. Shares PhaseSteps with Обновления so both long-running
// operations render the same dots.
export function ReloadStepper({
  status,
  errorCode,
}: {
  status: ReloadStatus | null | undefined;
  errorCode?: string;
}) {
  const s = useStrings();
  if (errorCode)
    return <p className="text-meta text-error">{errorMessage(s, errorCode)}</p>;
  if (!status) return <Skeleton className="h-6 w-full" />;

  const info = reloadStepInfo(status.state);

  if (info.outcome === "error") {
    return (
      <div className="flex flex-col gap-1.5">
        <StatePill state="error">
          {s.server.config.reload.states[status.state]}
        </StatePill>
        {status.error && (
          <p className="text-meta text-text-muted">{status.error}</p>
        )}
      </div>
    );
  }

  const steps: PhaseStep[] = HAPPY_STEPS.map((step, i) => ({
    key: step,
    label: s.server.config.reload.states[step],
    state:
      i < info.stepIndex ? "done" : i === info.stepIndex ? "active" : "pending",
  }));

  return (
    <PhaseSteps
      steps={steps}
      label={s.server.config.reload.title}
      progress={(info.stepIndex + 1) / HAPPY_STEPS.length}
      succeeded={info.outcome === "success"}
    />
  );
}
