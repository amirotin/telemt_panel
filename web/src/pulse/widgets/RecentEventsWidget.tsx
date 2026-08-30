import type { ComponentType, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
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
  neutral: "text-text-muted",
  warn: "text-warn",
  error: "text-error",
  ok: "text-ok",
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
export function RecentEventsWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<RuntimeTopic>("runtime");
  const now = useNow();

  if (!topic.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.recent_events} onHide={onHide}>
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
    const view = computeRecentEventsView(events.data);
    if (view.droppedTotal > 0) {
      tooltip = fill(s.pulse.recentEvents.dropped, { count: String(view.droppedTotal) });
    }
    body =
      view.rows.length === 0 ? (
        <EmptyState title={s.pulse.recentEvents.empty} />
      ) : (
        // The rail is one line drawn from the first marker's centre to the
        // last one's, behind markers that carry the card's own background —
        // every row is a single line, so the two ends land on the two
        // centres without measuring anything.
        <div className="relative">
          <span
            aria-hidden="true"
            className="absolute bottom-[15px] left-3 top-[15px] w-px -translate-x-1/2 bg-border"
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

function TimelineRow({ row, now }: { row: CoalescedEvent; now: number }) {
  const s = useStrings();
  const event = row.latest;
  const category = eventCategory(event.event_type);
  const tone = eventTone(event.event_type);
  const line = coalescedLine(row, s);
  const repeat = eventRepeatText(row, s);
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
      {/* One line: the transition for a collapsed run, the sentence for a
          type this catalog knows, Telemt's own type for one it does not,
          and Telemt's own context after either (§11.2's rule for these
          strings everywhere else in the panel). */}
      <span className="min-w-0 flex-1 truncate text-meta text-text">
        {line.text}
        {line.detail && <span className="text-text-muted"> · {line.detail}</span>}
        {repeat && (
          <span className="text-text-faint" data-testid="event-repeat">
            {" · "}
            {repeat}
          </span>
        )}
      </span>
      {/* Relative, because "how fresh is this" is the question a five-row
          feed answers; the exact instant is one hover away. */}
      <time
        dateTime={new Date(event.ts_epoch_secs * 1000).toISOString()}
        title={eventTimestamp(event.ts_epoch_secs, s)}
        className="shrink-0 text-micro tabular-nums text-text-faint"
      >
        {eventAgo(event.ts_epoch_secs, now, s)}
      </time>
    </li>
  );
}
