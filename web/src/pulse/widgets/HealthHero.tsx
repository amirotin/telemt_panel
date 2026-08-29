import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import type { State } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { StatePill } from "../../ui/StatePill";
import { IconUpgrade } from "../../ui/icons";
import { getUpdatesOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import { fill, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { computeHealthHero, telemtUpdateVersion, type HeroFact } from "./healthHero.helpers";

// The banner is the one block in the app painted as a *tinted* panel rather
// than a flat surface: a 135° wash of the state colour with a matching
// hairline, so the page's health reads before any text does. One entry per
// state so the tint, the border and the word can never drift apart.
const TONE: Record<State, { wash: string; border: string; text: string }> = {
  ok: {
    wash: "linear-gradient(135deg, rgb(var(--ok) / 0.14), rgb(var(--ok) / 0.04))",
    border: "border-ok/30",
    text: "text-ok",
  },
  warn: {
    wash: "linear-gradient(135deg, rgb(var(--warn) / 0.14), rgb(var(--warn) / 0.04))",
    border: "border-warn/30",
    text: "text-warn",
  },
  error: {
    wash: "linear-gradient(135deg, rgb(var(--error) / 0.14), rgb(var(--error) / 0.04))",
    border: "border-error/30",
    text: "text-error",
  },
  muted: {
    wash: "linear-gradient(135deg, rgb(var(--muted) / 0.12), rgb(var(--muted) / 0.03))",
    border: "border-border",
    text: "text-text-muted",
  },
};

// Fact — one of the small-caps pairs at the banner's right edge: the label
// above in the same caps grammar the app's section labels use, the value
// under it in tabular figures so three facts side by side stay aligned.
function Fact({ fact }: { fact: HeroFact }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-micro font-semibold uppercase tracking-[0.06em] text-text-faint">
        {fact.label}
      </span>
      <span className="truncate text-row font-semibold tabular-nums text-text">{fact.value}</span>
    </div>
  );
}

// HealthHero — «Статус», always first and never hideable (06-ui.md). Unlike
// every other widget it does NOT sit inside WidgetFrame and carries no
// heading of its own (owner decision 2026-08-30): a banner that says
// «Работает» does not also need a caption saying «Статус».
//
// ONE indicator. Previously this block held a coloured dot, a state word, a
// «Готовность: Готов» pill and a read_only pill — four affordances for two
// facts, and the reader had to reconcile them. Now the tone IS the
// indicator: when Telemt is serving, the word alone; when it is not, the
// tone turns and the banner says so in a sentence — «Не принимает
// клиентов» plus Telemt's own reason, translated.
export function HealthHero() {
  const s = useStrings();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const view = computeHealthHero(stats.data, s);
  // The release list behind the chip: a plain REST resource with its own
  // cache upstream (the update engine's), so a long staleTime and no retry
  // — the banner must never wait on GitHub, and an unreachable GitHub just
  // means no chip.
  const updates = useQuery({ ...getUpdatesOptions(), staleTime: 5 * 60_000, retry: false });
  const updateVersion = telemtUpdateVersion(updates.data);

  if (!view) {
    return (
      <section aria-label={s.pulse.widgets.health_hero}>
        <Skeleton className="h-[74px] w-full rounded-2xl" />
      </section>
    );
  }

  const tone = TONE[view.tone];

  return (
    <section aria-label={s.pulse.widgets.health_hero} data-testid="status-banner">
      <div
        className={cn("rounded-2xl border px-4 py-3.5", tone.border)}
        style={{ backgroundImage: tone.wash }}
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className={cn("text-[19px] font-bold leading-tight", tone.text)}>
                {view.label}
              </span>
              {/* Staleness is a different axis from health — the data on
                  screen may be minutes old while Telemt itself is fine —
                  and 06-ui.md requires every screen to say so. */}
              {stats.stale && <StatePill state="warn">{s.common.stale}</StatePill>}
            </div>
            {view.reason && (
              <p className="mt-1 text-meta leading-relaxed text-text-muted">{view.reason}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
            {view.facts.map((fact) => (
              <Fact key={fact.key} fact={fact} />
            ))}
            {updateVersion && (
              <Link
                to="/server/updates"
                className={cn(
                  "inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-full px-3",
                  "bg-accent/12 text-micro font-semibold text-accent transition-colors hover:bg-accent/20",
                )}
              >
                <IconUpgrade className="h-3.5 w-3.5" />
                {fill(s.overview.status.updateAvailable, { version: updateVersion })}
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
