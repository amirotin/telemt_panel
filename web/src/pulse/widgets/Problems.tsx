import { useSnapshot, useTopicWindow } from "../../realtime";
import type { StatsSnapshot, UpstreamsTopic } from "../../realtime/topics";
import { useCaps } from "../../caps";
import { useDisplayMode, visibleFor } from "../../display-mode";
import { CountBadge } from "../../ui/Chip";
import { Skeleton } from "../../ui/Skeleton";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { WidgetFrame } from "../WidgetFrame";
import {
  computeProblems,
  lifetimeCountersNote,
  problemSeverity,
  type StaleTopicInput,
} from "./problems.helpers";

// The rate window for the cumulative-counter rules — the same 15 minutes
// every other "за 15 мин" figure on Пульс uses (the history ring's own
// retention, ruling R3), so one glance at the dashboard covers one period.
const COUNTER_WINDOW_MS = 15 * 60 * 1000;

const SEVERITY_DOT: Record<ReturnType<typeof problemSeverity>, string> = {
  error: "bg-error",
  warn: "bg-warn",
  muted: "bg-muted",
};

// A detail that is a bare count belongs in the right-hand badge column
// (the prototype's ranked list); a detail that is a sentence — a readiness
// reason, a topic's error code — is prose and stays inline under the label.
function isCount(detail: string): boolean {
  return /^\d+$/.test(detail);
}

// Problems — a ranked list of everything currently wrong (06-ui.md), or the
// "всё в порядке" empty state. Non-hideable in the default layout's spirit
// but still technically hideable=true per registry.ts (the layout editor
// lets an operator hide it like any other widget — only health_hero is
// pinned).
export function Problems({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const runtime = useSnapshot("runtime");
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const security = useSnapshot("security");
  const caps = useCaps();
  const { mode } = useDisplayMode();
  // The oldest stats snapshot still inside the window is the baseline every
  // cumulative counter is diffed against; null until a second one arrives.
  const statsWindow = useTopicWindow<StatsSnapshot>("stats", COUNTER_WINDOW_MS);

  if (!stats.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.problems} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const staleTopics: StaleTopicInput[] = [
    { topic: "stats", stale: stats.stale, error: stats.error },
    { topic: "runtime", stale: runtime.stale, error: runtime.error },
    { topic: "upstreams", stale: upstreams.stale, error: upstreams.error },
    { topic: "security", stale: security.stale, error: security.error },
  ];
  const capabilities = caps.data?.capabilities;
  const missingCapabilities = capabilities
    ? (Object.keys(capabilities) as Array<keyof typeof capabilities>).filter((k) => !capabilities[k])
    : [];

  const items = computeProblems(
    stats.data,
    staleTopics,
    missingCapabilities,
    upstreams.data?.dcs ?? null,
    s,
    statsWindow.oldest?.data ?? null,
  );
  // Extended mode only: computeProblems no longer alarms on counters that
  // are not currently growing, so this is where their lifetime totals get
  // acknowledged instead of silently vanishing.
  const lifetimeNote = visibleFor("extended", mode) ? lifetimeCountersNote(stats.data, s) : null;
  const note = lifetimeNote && (
    <p className="mt-2 text-micro leading-relaxed text-text-faint">{lifetimeNote}</p>
  );

  if (items.length === 0) {
    // "Nothing is wrong" is the common state on a healthy server, so it
    // gets a quiet ok-tinted line rather than the app's dashed EmptyState
    // box — a large placeholder announcing good news reads as a defect.
    return (
      <WidgetFrame title={s.pulse.widgets.problems} onHide={onHide}>
        <div className="flex items-start gap-2.5 rounded-md bg-ok/10 px-3 py-2.5">
          <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-ok" />
          <div className="min-w-0">
            <span className="block text-row font-semibold text-ok">{s.pulse.problems.none}</span>
            <span className="mt-0.5 block text-micro text-text-muted">
              {s.pulse.problems.noneDescription}
            </span>
          </div>
        </div>
        {note}
      </WidgetFrame>
    );
  }

  return (
    <WidgetFrame
      title={s.pulse.widgets.problems}
      onHide={onHide}
      badge={<CountBadge tone="warn">{items.length}</CountBadge>}
    >
      <ul className="flex flex-col">
        {items.map((item) => {
          const severity = problemSeverity(item.key);
          // An explicit `count` wins; otherwise a bare-number `detail` still
          // doubles as the badge, as it always has.
          const badge =
            item.count ?? (item.detail !== undefined && isCount(item.detail) ? item.detail : undefined);
          const prose = item.detail !== undefined && item.detail !== badge ? item.detail : undefined;
          return (
            <li
              key={item.key}
              className="flex items-start gap-2.5 border-b border-border py-2 last:border-b-0"
            >
              <span
                aria-hidden="true"
                className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", SEVERITY_DOT[severity])}
              />
              <div className="min-w-0 flex-1">
                <span className="block text-row text-text">{item.label}</span>
                {prose !== undefined && (
                  <span className="mt-0.5 block text-micro leading-relaxed text-text-muted">
                    {prose}
                  </span>
                )}
                {item.hint !== undefined && (
                  <span className="mt-0.5 block text-micro italic leading-relaxed text-text-faint">
                    {item.hint}
                  </span>
                )}
              </div>
              {badge !== undefined && (
                <CountBadge tone={severity === "error" ? "error" : "warn"} className="mt-0.5">
                  {badge}
                </CountBadge>
              )}
            </li>
          );
        })}
      </ul>
      {note}
    </WidgetFrame>
  );
}
