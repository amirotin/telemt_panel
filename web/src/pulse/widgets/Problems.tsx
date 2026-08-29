import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useSnapshot, useTopicWindow } from "../../realtime";
import type { StatsSnapshot, UpstreamsTopic } from "../../realtime/topics";
import { useCaps } from "../../caps";
import { useDisplayMode, visibleFor } from "../../display-mode";
import { CountBadge } from "../../ui/Chip";
import { IconButton } from "../../ui/IconButton";
import { Skeleton } from "../../ui/Skeleton";
import { IconCheck, IconChevronRight, IconClose, IconInfo, IconWarning } from "../../ui/icons";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { WidgetFrame } from "../WidgetFrame";
import {
  computeProblems,
  lifetimeCountersNote,
  problemDomain,
  problemSeverity,
  type ProblemItem,
  type StaleTopicInput,
} from "./problems.helpers";

// The rate window for the cumulative-counter rules — the same 15 minutes
// every other "за 15 мин" figure on Сводка is measured over. This one is cut
// from the SSE topic's own buffer (useTopicWindow), not from the history
// ring, so widening the ring to 30 minutes left it alone.
const COUNTER_WINDOW_MS = 15 * 60 * 1000;

const SEVERITY_TEXT: Record<ReturnType<typeof problemSeverity>, string> = {
  error: "text-error",
  warn: "text-warn",
  muted: "text-text-faint",
};

// Problems — the adaptive card of concept §6/§17: one line while nothing is
// wrong, a ranked list of what IS wrong otherwise. Non-hideable in the
// default layout's spirit but still technically hideable=true per registry.ts
// (the layout editor lets an operator hide it like any other widget — only
// health_hero is pinned).
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
    // Concept §17: in the normal state the card takes the minimum space it
    // can — ONE row, no title over it and no tinted box around it. A large
    // green panel announcing good news is the loudest thing on a healthy
    // dashboard, which is exactly backwards.
    return (
      <section className="rounded-xl border border-border bg-surface px-3.5 py-3">
        <div className="flex min-h-[32px] items-center gap-2.5">
          {/* The heading stays in the accessibility tree even though the
              healthy card shows no title: it is what names this section in a
              screen reader's outline, and what the hide button refers to. */}
          <h2 className="sr-only">{s.pulse.widgets.problems}</h2>
          <IconCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-ok" />
          <span className="min-w-0 flex-1 truncate text-row text-text-muted">
            {s.pulse.problems.none}
          </span>
          {onHide && (
            <IconButton aria-label={s.pulse.hideWidget} onClick={onHide} className="text-[15px]">
              <IconClose />
            </IconButton>
          )}
        </div>
        {note}
      </section>
    );
  }

  return (
    <WidgetFrame
      title={s.pulse.widgets.problems}
      onHide={onHide}
      badge={<CountBadge tone="warn">{items.length}</CountBadge>}
    >
      <ul className="flex flex-col">
        {items.map((item) => (
          <li key={item.key} className="border-b border-border last:border-b-0">
            <ProblemRow item={item} />
          </li>
        ))}
      </ul>
      {note}
    </WidgetFrame>
  );
}

// ProblemRow renders one problem, as a link into the Пульс page that
// explains it when there is one (problemDomain) and as plain text when
// there is not. Both shapes carry the same body, so a linked and an
// unlinked row line up in the same column grid.
function ProblemRow({ item }: { item: ProblemItem }) {
  const domain = problemDomain(item.key);
  const body = <ProblemRowBody item={item} linked={domain !== undefined} />;
  if (domain === undefined) {
    return <div className="flex items-start gap-2.5 px-1 py-2">{body}</div>;
  }
  return (
    <Link
      to="/pulse/diag/$domain"
      params={{ domain }}
      className="flex items-start gap-2.5 rounded-md px-1 py-2 transition-colors hover:bg-surface-2"
    >
      {body}
    </Link>
  );
}

function ProblemRowBody({ item, linked }: { item: ProblemItem; linked: boolean }): ReactNode {
  const severity = problemSeverity(item.key);
  const Icon = severity === "muted" ? IconInfo : IconWarning;
  return (
    <>
      <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", SEVERITY_TEXT[severity])} />
      <div className="min-w-0 flex-1">
        <span className="block text-row text-text">{item.label}</span>
        {item.detail !== undefined && (
          <span className="mt-0.5 block text-micro leading-relaxed text-text-muted">
            {item.detail}
          </span>
        )}
        {item.hint !== undefined && (
          <span className="mt-0.5 block truncate text-micro italic leading-relaxed text-text-faint">
            {item.hint}
          </span>
        )}
      </div>
      {linked && <IconChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-text-faint" />}
    </>
  );
}
