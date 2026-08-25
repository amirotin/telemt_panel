import type { ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { EmptyState } from "../../ui/EmptyState";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { resolveGated } from "./gated";
import { computeRecentEventsView } from "./recentEvents.helpers";

export function RecentEventsWidget({ onHide }: { onHide?: () => void }) {
  const topic = useSnapshot<RuntimeTopic>("runtime");

  if (!topic.data) {
    return (
      <WidgetFrame title={ru.pulse.widgets.recent_events} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const events = resolveGated(topic.data.recent_events);
  let body: ReactNode;
  if (events.status === "gated") {
    body = <Gated enabled={false} reason={events.reason} hint="runtime_edge" />;
  } else {
    const view = computeRecentEventsView(events.data);
    body =
      view.events.length === 0 ? (
        <EmptyState title={ru.pulse.recentEvents.empty} />
      ) : (
        <div className="flex flex-col">
          <ul className="flex flex-col divide-y divide-border">
            {view.events.map((e) => (
              <li key={e.seq} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                <span className="truncate text-text">{e.event_type}</span>
                <span className="shrink-0 truncate text-xs text-text-muted">{e.context}</span>
              </li>
            ))}
          </ul>
          {view.droppedTotal > 0 && (
            <p className="pt-1 text-xs text-text-faint">
              {view.droppedTotal} {ru.pulse.recentEvents.dropped}
            </p>
          )}
        </div>
      );
  }

  return (
    <WidgetFrame title={ru.pulse.widgets.recent_events} onHide={onHide} stale={topic.stale}>
      {body}
    </WidgetFrame>
  );
}
