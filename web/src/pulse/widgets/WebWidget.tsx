import { useSnapshot } from "../../realtime";
import type { WebTopic } from "../../realtime/topics";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { fill, formatNumber, pluralTemplate, useStrings } from "../../i18n";
import { WidgetFrame } from "../WidgetFrame";
import { computeWebCard, type WebCardView } from "./web.helpers";

// WebWidget — «WEB» as concept §11's subsystem card, the second of the
// three §13 stacks beside the data-center board.
//
// Adaptive per §17, and the adaptivity here is real rather than cosmetic:
// a closed WEB has nothing to count, so the card is two lines — the title
// and the state — while a running one carries its listeners, its sessions
// and the rejections it has made against a limit.
//
// The state this panel meets most often is «Нет в этой версии». WEB landed
// in Telemt 3.5.3 and a 3.4.x proxy has no /v1/runtime/web/* route at all;
// hub.go turns that into a gate with its own reason token rather than an
// error, and the card reports it as a version, calmly, with no "enable
// this" advice for a setting the binary does not have.
export function WebWidget() {
  const s = useStrings();
  const topic = useSnapshot<WebTopic>("web");

  if (!topic.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.web} diagDomain="web">
        <Skeleton className="h-12 w-full" />
      </WidgetFrame>
    );
  }

  const view = computeWebCard(topic.data.status);

  return (
    <WidgetFrame
      title={s.pulse.widgets.web}
      stale={topic.stale}
      diagDomain="web"
      badge={
        <StatePill state={view.tone} title={view.reason}>
          {s.pulse.web.state[view.state]}
        </StatePill>
      }
    >
      <div data-testid="web-card" className="flex flex-col gap-1">
        <WebBody view={view} />
      </div>
    </WidgetFrame>
  );
}

function WebBody({ view }: { view: WebCardView }) {
  const s = useStrings();

  if (view.compact) {
    // Two lines and no figures: a WEB that is off, absent or momentarily
    // unreadable has nothing to count, and a grid of zeros would say it
    // does. The second line is the one sentence that explains the first.
    return (
      <p className="text-meta text-text-muted" data-testid="web-compact">
        {s.pulse.web.hint[view.state === "unsupported" ? "unsupported" : "closed"]}
      </p>
    );
  }

  return (
    <>
      <p className="text-meta tabular-nums text-text" data-testid="web-counts">
        {pluralTemplate(s, view.listeners.length, s.pulse.web.listeners)}
        {view.sessions !== null && ` · ${pluralTemplate(s, view.sessions, s.pulse.web.sessions)}`}
      </p>
      <p className="truncate font-mono text-micro text-text-muted" data-testid="web-listeners">
        {view.listeners.length > 0 ? view.listeners.join(" · ") : s.pulse.web.noListeners}
      </p>
      {view.limitHits !== null && view.limitHits > 0 && (
        <p className="text-micro tabular-nums text-text-faint" data-testid="web-limit-hits">
          {fill(s.pulse.web.limitHits, { count: formatNumber(s, view.limitHits) })}
        </p>
      )}
      {/* §17: a draining or starting runtime says WHY, in Telemt's own word. */}
      {view.state !== "running" && view.reason && (
        <p className="truncate text-meta text-warn" data-testid="web-reason">
          {view.reason}
        </p>
      )}
    </>
  );
}
