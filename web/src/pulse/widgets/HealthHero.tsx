import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import type { State } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { StatePill } from "../../ui/StatePill";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { computeHealthHero } from "./healthHero.helpers";

// The hero is the one block in the app painted as a *tinted* panel rather
// than a flat surface: the prototype gives it a 135° wash of the state
// colour with a matching hairline, so the page's health reads before any
// text does. One entry per status so the tint, the border and the dot glow
// can never drift apart.
const TONE: Record<State, { wash: string; border: string; dot: string; glow: string }> = {
  ok: {
    wash: "linear-gradient(135deg, rgb(var(--ok) / 0.14), rgb(var(--ok) / 0.04))",
    border: "border-ok/30",
    dot: "bg-ok",
    glow: "0 0 10px rgb(var(--ok) / 0.7)",
  },
  warn: {
    wash: "linear-gradient(135deg, rgb(var(--warn) / 0.14), rgb(var(--warn) / 0.04))",
    border: "border-warn/30",
    dot: "bg-warn",
    glow: "0 0 10px rgb(var(--warn) / 0.7)",
  },
  error: {
    wash: "linear-gradient(135deg, rgb(var(--error) / 0.14), rgb(var(--error) / 0.04))",
    border: "border-error/30",
    dot: "bg-error",
    glow: "0 0 10px rgb(var(--error) / 0.7)",
  },
  muted: {
    wash: "linear-gradient(135deg, rgb(var(--muted) / 0.12), rgb(var(--muted) / 0.03))",
    border: "border-border",
    dot: "bg-muted",
    glow: "none",
  },
};

function HeroShell({ children }: { children: React.ReactNode }) {
  const s = useStrings();
  return (
    <section className="flex flex-col gap-1.5">
      {/* The caption keeps the widget's registry title on screen (the layout
          editor and the shell both name this block «Статус»); the prototype
          hero carries no title of its own. */}
      <h3 className="text-micro font-semibold uppercase tracking-[0.06em] text-text-faint">
        {s.pulse.widgets.health_hero}
      </h3>
      {children}
    </section>
  );
}

// HealthHero — always first, never hideable (06-ui.md). No onHide prop is
// wired for it in registry.ts (WidgetDef.hideable: false), so no hide
// affordance is rendered for this widget regardless of what's passed.
// Unlike every other widget it does NOT sit inside WidgetFrame: the
// prototype's hero is a full-bleed tinted panel, not a titled card.
export function HealthHero() {
  const s = useStrings();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const view = computeHealthHero(stats.data, s);

  if (!view) {
    return (
      <HeroShell>
        <Skeleton className="h-[86px] w-full rounded-2xl" />
      </HeroShell>
    );
  }

  const tone = TONE[view.pillState];
  const reason =
    view.ready === false ? (view.readyReason ?? s.pulse.health.noReason) : undefined;

  return (
    <HeroShell>
      <div
        className={cn("rounded-2xl border p-4", tone.border)}
        style={{ backgroundImage: tone.wash }}
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <span
            aria-hidden="true"
            className={cn("h-3 w-3 shrink-0 rounded-full", tone.dot)}
            style={{ boxShadow: tone.glow }}
          />
          <span className="text-[17px] font-bold text-text">{view.label}</span>
          {view.ready !== null && (
            <StatePill state={view.ready ? "ok" : "error"}>
              {s.pulse.health.readyLabel}:{" "}
              {view.ready ? s.pulse.health.ready : s.pulse.health.notReady}
            </StatePill>
          )}
          {view.readOnly && <StatePill state="warn">{s.pulse.health.readOnly}</StatePill>}
          {stats.stale && <StatePill state="warn">{s.common.stale}</StatePill>}
        </div>
        {reason && <p className="mt-1.5 text-meta leading-relaxed text-text-muted">{reason}</p>}
      </div>
    </HeroShell>
  );
}
