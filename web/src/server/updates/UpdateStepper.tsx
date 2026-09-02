import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { StatePill } from "../../ui/StatePill";
import { IconRefresh, IconWarning } from "../../ui/icons";
import type { UpdatePhase } from "./updatePhase.helpers";

const GROUPS: Array<{ phases: UpdatePhase[]; labelPhase: UpdatePhase }> = [
  { phases: ["checking"], labelPhase: "checking" },
  { phases: ["downloading", "verifying"], labelPhase: "downloading" },
  { phases: ["staging"], labelPhase: "staging" },
  { phases: ["installing"], labelPhase: "installing" },
  { phases: ["restarting", "health"], labelPhase: "restarting" },
  { phases: ["done"], labelPhase: "done" },
];

// The engine exposes eight happy-path phases. On the narrow horizontal track
// closely related technical phases are grouped into six readable milestones;
// the header still names the exact current engine phase.
export function UpdateStepper({
  phase,
  detail,
  streamFallback = false,
}: {
  phase: UpdatePhase;
  detail?: string;
  streamFallback?: boolean;
}) {
  const s = useStrings();

  if (phase === "rolling_back" || phase === "rolled_back") {
    return (
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-warn/10 text-warn"><IconRefresh aria-hidden="true" /></span>
        <div className="min-w-0">
          <StatePill state="warn">{s.server.updates.phases[phase]}</StatePill>
          <p className="mt-1.5 text-meta font-semibold text-text">
            {phase === "rolled_back"
              ? s.server.updates.rollbackCompleted
              : s.server.updates.rollbackInProgress}
          </p>
          {detail && <p className="mt-1 break-words font-mono text-micro leading-relaxed text-text-muted">{detail}</p>}
        </div>
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-error/10 text-error"><IconWarning aria-hidden="true" /></span>
        <div className="min-w-0">
          <StatePill state="error">{s.server.updates.phases.failed}</StatePill>
          {detail && <p className="mt-1.5 break-words font-mono text-micro leading-relaxed text-text-muted">{detail}</p>}
        </div>
      </div>
    );
  }

  const activeIndex = Math.max(
    0,
    GROUPS.findIndex((group) => group.phases.includes(phase)),
  );
  const finished = phase === "done";

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="truncate text-meta font-semibold text-text">
          {s.server.updates.phases[phase]}
        </p>
        <span className="shrink-0 font-mono text-micro font-semibold tabular-nums text-accent">
          {activeIndex + 1} {s.server.updates.stepOf} {GROUPS.length}
        </span>
      </div>

      <div className="pb-1">
        <ol className="relative grid w-full grid-cols-6">
          <span className="absolute left-[8.33%] right-[8.33%] top-[7px] h-px bg-border-strong" aria-hidden="true" />
          {GROUPS.map((group, index) => {
            const done = finished || index < activeIndex;
            const active = !finished && index === activeIndex;
            return (
              <li key={group.labelPhase} className="relative z-[1] min-w-0 text-center">
                <span
                  className={cn(
                    "mx-auto mb-1.5 block h-[15px] w-[15px] rounded-full border-[3px] border-surface-sunken ring-1",
                    done && "bg-ok ring-ok",
                    active && "bg-accent ring-accent shadow-[0_0_0_5px_rgba(58,167,216,0.08)]",
                    !done && !active && "bg-border-strong ring-border-strong",
                  )}
                  aria-hidden="true"
                />
                <span className={cn("block truncate px-0.5 text-[8px] sm:px-1 sm:text-[9px]", done || active ? "text-text-muted" : "text-text-faint")}>
                  {s.server.updates.phases[group.labelPhase]}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {detail && <p className="mt-2 break-words font-mono text-micro leading-relaxed text-text-faint">{detail}</p>}
      {streamFallback && (
        <p className="mt-2 flex items-start gap-1.5 text-micro leading-relaxed text-text-faint">
          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />
          {s.server.updates.sseStale}
        </p>
      )}
    </div>
  );
}
