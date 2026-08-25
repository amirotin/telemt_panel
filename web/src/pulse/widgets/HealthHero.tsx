import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import { Skeleton } from "../../ui/Skeleton";
import { StatePill } from "../../ui/StatePill";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { computeHealthHero } from "./healthHero.helpers";

// HealthHero — always first, never hideable (06-ui.md). No onHide prop is
// wired for it in registry.ts (WidgetDef.hideable: false), so the frame
// never renders a hide button for this widget regardless of what's passed.
export function HealthHero() {
  const stats = useSnapshot<StatsSnapshot>("stats");
  const view = computeHealthHero(stats.data);

  if (!view) {
    return (
      <WidgetFrame title={ru.pulse.widgets.health_hero}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  return (
    <WidgetFrame title={ru.pulse.widgets.health_hero} stale={stats.stale}>
      <div className="flex flex-wrap items-center gap-2">
        <StatePill state={view.pillState}>{view.label}</StatePill>
        {view.ready !== null && (
          <StatePill state={view.ready ? "ok" : "error"}>
            {ru.pulse.health.readyLabel}: {view.ready ? ru.pulse.health.ready : ru.pulse.health.notReady}
          </StatePill>
        )}
        {view.readOnly && <StatePill state="warn">{ru.pulse.health.readOnly}</StatePill>}
      </div>
      {view.ready === false && (
        <p className="text-sm text-text-muted">{view.readyReason ?? ru.pulse.health.noReason}</p>
      )}
    </WidgetFrame>
  );
}
