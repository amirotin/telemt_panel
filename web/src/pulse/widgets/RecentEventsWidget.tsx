import type { ComponentType, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeEdgeEventRecord, RuntimeTopic } from "../../realtime/topics";
import { EmptyState } from "../../ui/EmptyState";
import { Skeleton } from "../../ui/Skeleton";
import { buttonClasses } from "../../ui/buttonStyles";
import {
  IconChevronRight,
  IconClose,
  IconPeople,
  IconRefresh,
  IconSwap,
  IconTarget,
  IconWarning,
  type IconProps,
} from "../../ui/icons";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import { resolveGated } from "./gated";
import {
  computeRecentEventsView,
  eventCategory,
  eventTime,
  eventTone,
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
  neutral: "text-text-muted",
  warn: "text-warn",
  error: "text-error",
  ok: "text-ok",
};

// RecentEventsWidget — «События» as concept §15's timeline: a rail, a
// category marker per row, the time, and the event on one line. It replaces
// the two-column list whose left column was the raw type and whose right
// column was a truncated context nobody could line up against it.
//
// The last five rows only; «Все события →» in the header opens
// /pulse/diag/events, where all fifty live behind a family filter.
export function RecentEventsWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<RuntimeTopic>("runtime");

  if (!topic.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.recent_events} onHide={onHide}>
        <Skeleton className="h-24 w-full" />
      </WidgetFrame>
    );
  }

  const events = resolveGated(topic.data.recent_events);
  let body: ReactNode;
  if (events.status === "gated") {
    body = <GatedNote reason={events.reason} hint="runtime_edge" />;
  } else {
    const view = computeRecentEventsView(events.data);
    body =
      view.events.length === 0 ? (
        <EmptyState title={s.pulse.recentEvents.empty} />
      ) : (
        <div className="flex flex-col gap-2">
          {/* The rail is one line drawn from the first marker's centre to
              the last one's, behind markers that carry the card's own
              background — every row is a single line, so the two ends land
              on the two centres without measuring anything. */}
          <div className="relative">
            <span
              aria-hidden="true"
              className="absolute bottom-[15px] left-3 top-[15px] w-px -translate-x-1/2 bg-border"
            />
            <ol className="relative flex flex-col">
              {view.events.map((event) => (
                <TimelineRow key={event.seq} event={event} />
              ))}
            </ol>
          </div>
          {view.droppedTotal > 0 && (
            <p className="text-micro text-text-muted">
              {view.droppedTotal} {s.pulse.recentEvents.dropped}
            </p>
          )}
        </div>
      );
  }

  return (
    <WidgetFrame
      title={s.pulse.widgets.recent_events}
      onHide={onHide}
      stale={topic.stale}
      action={
        <Link
          to="/pulse/diag/$domain"
          params={{ domain: "events" }}
          className={buttonClasses("secondary", "sm", "gap-1")}
        >
          {s.pulse.recentEvents.all}
          <IconChevronRight className="h-3.5 w-3.5" />
        </Link>
      }
    >
      {body}
    </WidgetFrame>
  );
}

function TimelineRow({ event }: { event: RuntimeEdgeEventRecord }) {
  const s = useStrings();
  const category = eventCategory(event.event_type);
  const tone = eventTone(event.event_type);
  const Glyph = category === "neutral" ? null : CATEGORY_ICON[category];

  return (
    <li className="flex items-center gap-2.5 py-[3px]" data-testid="event-row">
      <span
        data-testid="event-marker"
        data-category={category}
        data-tone={tone}
        className={cn(
          "relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface",
          TONE_ICON[tone],
        )}
        aria-hidden="true"
      >
        {Glyph ? (
          <Glyph className="h-3.5 w-3.5" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
        )}
      </span>
      <time
        dateTime={new Date(event.ts_epoch_secs * 1000).toISOString()}
        className="shrink-0 font-mono text-micro tabular-nums text-text-faint"
      >
        {eventTime(event.ts_epoch_secs, s)}
      </time>
      {/* One line, verbatim: Telemt's own type names the row and its own
          context explains it (§11.2's rule for these strings everywhere
          else in the panel). */}
      <span className="min-w-0 flex-1 truncate text-meta text-text">
        {event.event_type}
        {event.context && <span className="text-text-muted"> · {event.context}</span>}
      </span>
    </li>
  );
}
