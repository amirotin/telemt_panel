import { healthLabel, healthPillState } from "../../shell/StatusStrip.helpers";
import type { State } from "../../ui/StatePill";
import type { StatsSnapshot } from "../../realtime/topics";

export interface HealthHeroView {
  pillState: State;
  label: string;
  /** null when the `ready` sub-call hasn't come back yet at all. */
  ready: boolean | null;
  readyReason?: string;
  readOnly: boolean;
}

// computeHealthHero reuses StatusStrip's own health-pill/label semantics
// (shell/StatusStrip.helpers.ts) so the always-visible status strip and the
// Пульс hero never disagree about what "ok" means, then layers on the
// readiness reason and read_only badge the hero additionally shows
// (06-ui.md: "health/ready + причина словами + read_only-бейдж").
export function computeHealthHero(stats: StatsSnapshot | null): HealthHeroView | null {
  if (!stats) return null;
  return {
    pillState: healthPillState(stats.health?.status),
    label: healthLabel(stats.health?.status),
    ready: stats.ready?.ready ?? null,
    readyReason: stats.ready?.reason,
    readOnly: stats.health?.read_only ?? false,
  };
}
