import type { ComponentType, ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { EmptyState } from "../../ui/EmptyState";
import { Skeleton } from "../../ui/Skeleton";
import {
  IconClose,
  IconPeople,
  IconRefresh,
  IconSwap,
  IconTarget,
  IconWarning,
  type IconProps,
} from "../../ui/icons";
import { fill, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { useNow } from "../../people/useNow";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import { resolveGated } from "./gated";
import {
  coalescedLine,
  computeRecentEventsView,
  eventAgo,
  eventCategory,
  eventRepeatText,
  eventTime,
  eventTimestamp,
  eventTone,
  type CoalescedEvent,
  type EventCategory,
  type EventTone,
} from "./recentEvents.helpers";

// Concept §15's category glyphs — `↻ ◎ ⇄ ♙ ⚠ ✕`, in the app's own line
// style. `neutral` has no icon on purpose: an unrecognised event type gets
// a plain dot rather than being forced into the nearest category.
const CATEGORY_ICON: Record<Exclude<EventCategory, "neutral">, ComponentType<IconProps>> = {
  reload: IconRefresh,
  listener: IconTarget,
  routing: IconSwap,
  user: IconPeople,
  warning: IconWarning,
  error: IconClose,
};

// §15's colour rule: the rail is neutral, and only warning/error/success
// tint their marker. The TEXT stays neutral in every case — a timeline
// where five rows out of five are coloured says nothing.
const TONE_ICON: Record<EventTone, string> = {
  neutral: "border-accent/40 text-accent",
  warn: "border-warn/50 text-warn",
  error: "border-error/50 text-error",
  ok: "border-ok/45 text-ok",
};

// RecentEventsWidget — «События» as concept §15's timeline: a rail, a
// category marker per row, the event in words, and how long ago it was.
//
// Five rows, and each row is a RUN rather than a record. A flapping proxy
// fills Telemt's fifty-slot ring with one fact repeated, and the widget
// used to spend all five rows on it («Приём клиентов открыт / закрыт /
// открыт / закрыт / открыт»); now that run is one row that states the
// transition and counts itself — «Приём клиентов: закрыт → открыт · ×3 за
// 2 ч.» — and the other four rows show the four other things that happened.
//
// `dropped_total` moved to the title's tooltip. It is a fact about the ring
// (records evicted since start, which the panel will never see), not an
// event, and it was costing a line of a five-line feed.
export function RecentEventsWidget({ rail = false }: { rail?: boolean }) {
  const s = useStrings();
  const topic = useSnapshot<RuntimeTopic>("runtime");
  const now = useNow();

  if (!topic.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.recent_events} diagDomain="events">
        <Skeleton className="h-24 w-full" />
      </WidgetFrame>
    );
  }

  const events = resolveGated(topic.data.recent_events);
  let body: ReactNode;
  let tooltip: string | undefined;
  if (events.status === "gated") {
    body = <GatedNote reason={events.reason} hint="runtime_edge" />;
  } else {
    const view = computeRecentEventsView(events.data, rail ? 6 : 5);
    if (view.droppedTotal > 0) {
      tooltip = fill(s.pulse.recentEvents.dropped, { count: String(view.droppedTotal) });
    }
    body =
      view.rows.length === 0 ? (
        <EmptyState title={s.pulse.recentEvents.empty} />
      ) : (
        // The selected design-lab variant keeps a dedicated HH:MM column,
        // a softly fading axis and a full typographic column. Repeats and
        // relative age stay on the third line, where narrow rails cannot
        // squeeze them beside the event sentence.
        <div
          className={cn("relative pt-1", rail && "max-h-[680px] overflow-y-auto pr-1")}
          data-testid="event-timeline"
        >
          <span
            aria-hidden="true"
            className="absolute bottom-8 left-[77px] top-3 w-0.5"
            style={{
              background:
                "linear-gradient(180deg, rgb(var(--accent) / .72), rgb(var(--ok) / .32) 55%, rgb(var(--border-strong) / .3))",
            }}
          />
          <ol className="relative flex flex-col">
            {view.rows.map((row) => (
              <TimelineRow key={row.latest.seq} row={row} now={now} />
            ))}
          </ol>
        </div>
      );
  }

  return (
    <WidgetFrame
      title={s.pulse.widgets.recent_events}
      titleTooltip={tooltip}
      diagDomain="events"
      stale={topic.stale}
      className={rail ? "min-h-[620px]" : undefined}
    >
      {body}
    </WidgetFrame>
  );
}

function TimelineRow({ row, now }: { row: CoalescedEvent; now: number }) {
  const s = useStrings();
  const event = row.latest;
  const category = eventCategory(event.event_type);
  const tone = eventTone(event.event_type);
  const line = coalescedLine(row, s);
  const repeat = eventRepeatText(row, s);
  const ago = eventAgo(event.ts_epoch_secs, now, s);
  const Glyph = category === "neutral" ? null : CATEGORY_ICON[category];

  return (
    <li
      className="relative grid min-h-[98px] grid-cols-[64px_26px_minmax(0,1fr)] items-start"
      data-testid="event-row"
    >
      <time
        dateTime={new Date(event.ts_epoch_secs * 1000).toISOString()}
        title={eventTimestamp(event.ts_epoch_secs, s)}
        className="pr-2.5 pt-0.5 text-right font-mono text-[11px] leading-[1.35] tabular-nums text-accent"
        data-testid="event-time"
      >
        {eventTime(event.ts_epoch_secs, s)}
      </time>
      <span
        data-testid="event-marker"
        data-category={category}
        data-tone={tone}
        className={cn(
          "relative z-[1] grid h-5 w-5 place-items-center justify-self-center rounded-[7px] border bg-surface shadow-[0_0_0_4px_rgb(var(--surface))]",
          TONE_ICON[tone],
        )}
        aria-hidden="true"
      >
        {Glyph ? (
          <Glyph className="h-3 w-3" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-sm bg-current" />
        )}
      </span>
      <div className="min-w-0 pb-3 pl-2.5" data-testid="event-copy">
        <p className="text-[13px] font-semibold leading-[1.4] text-text">{line.text}</p>
        {line.detail && <p className="mt-1 text-[11px] leading-[1.45] text-text-muted">{line.detail}</p>}
        <p className="mt-1.5 text-[10px] leading-[1.35] text-accent">
          {repeat ? (
            <>
              <span data-testid="event-repeat">{repeat}</span>
              <span aria-hidden="true"> · </span>
              {ago}
            </>
          ) : (
            ago
          )}
        </p>
      </div>
    </li>
  );
}
