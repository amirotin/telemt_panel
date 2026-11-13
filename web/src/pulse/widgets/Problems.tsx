import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useSnapshot, useTopicWindow } from "../../realtime";
import type { RuntimeTopic, StatsSnapshot, UpstreamsTopic } from "../../realtime/topics";
import { useCaps } from "../../caps";
import { CountBadge } from "../../ui/Chip";
import { Skeleton } from "../../ui/Skeleton";
import { IconCheck, IconChevronRight, IconInfo, IconWarning } from "../../ui/icons";
import { formatNumber, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/Button";
import { WidgetFrame } from "../WidgetFrame";
import { resolveGated } from "./gated";
import { computeMeCard } from "./mePool.helpers";
import {
  computeProblems,
  addMeRuntimeProblem,
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

// Retain a minimum footprint, but never clip the information needed to act.
export function Problems() {
  const s = useStrings();
  const [expanded, setExpanded] = useState(false);
  const stats = useSnapshot<StatsSnapshot>("stats");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const security = useSnapshot("security");
  const caps = useCaps();
  // The oldest stats snapshot still inside the window is the baseline every
  // cumulative counter is diffed against; null until a second one arrives.
  const statsWindow = useTopicWindow<StatsSnapshot>("stats", COUNTER_WINDOW_MS);

  if (!stats.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.problems} className="min-h-[174px]">
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
  // State flags do not describe feature support.
  const missingCapabilities = capabilities
    ? (Object.keys(capabilities) as Array<keyof typeof capabilities>).filter((k) => k !== "read_only" && k !== "optional_metadata_unavailable" && !capabilities[k])
    : [];

  let items = computeProblems(
    stats.data,
    staleTopics,
    missingCapabilities,
    upstreams.data?.dcs ?? null,
    s,
    statsWindow.oldest?.data ?? null,
  );
  if (runtime.data) {
    const pool = resolveGated(runtime.data.me_pool_state);
    const quality = resolveGated(runtime.data.me_quality);
    if (pool.status === "ok") {
      const me = computeMeCard(
        pool.data,
        quality.status === "ok" ? quality.data : undefined,
        runtime.data.gates,
      );
      items = addMeRuntimeProblem(items, me.reason, s);
    }
  }
  if (items.length === 0) {
    return (
      <WidgetFrame title={s.pulse.widgets.problems} className="min-h-[174px]">
        <ul className="flex flex-1 flex-col">
          <li className="flex min-h-[56px] items-start gap-2.5 px-1 py-2">
            <IconCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
            <div className="min-w-0 flex-1">
              <p className="text-row text-text">{s.pulse.problems.none}</p>
              <p className="mt-1 text-meta leading-relaxed text-text-muted">
                {s.pulse.problems.noneHint}
              </p>
            </div>
          </li>
        </ul>
      </WidgetFrame>
    );
  }

  const visibleItems = expanded ? items : items.slice(0, 6);
  const remaining = items.length - visibleItems.length;
  return (
    <WidgetFrame
      title={s.pulse.widgets.problems}
      badge={<CountBadge tone="warn">{items.length}</CountBadge>}
      className="overview-problems min-h-[174px]"
    >
      <ul className="overview-problem-grid" data-testid="overview-problems">
        {visibleItems.map((item) => (
          <li key={item.key} className="min-w-0" data-testid="overview-problem">
            <ProblemRow item={item} />
          </li>
        ))}
      </ul>
      {items.length > 6 && (
        <Button variant="secondary" className="self-start" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? s.pulse.problems.showLess : `${s.pulse.problems.showMore} · +${formatNumber(s, remaining)}`}
        </Button>
      )}
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
    return <div className="flex h-full min-h-16 items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5">{body}</div>;
  }
  return (
    <Link
      to="/pulse/diag/$domain"
      params={{ domain }}
      search={item.key === "tls_probe_anomaly" ? { tab: "tls", tlsScope: "by_ip", tlsFilter: "suspicious" } : {}}
      className="flex h-full min-h-16 items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 transition-colors hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
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
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="block text-row text-text">{item.label}</span>
        {item.detail !== undefined && (
          <span className="mt-0.5 block text-meta leading-relaxed text-text-muted">
            {item.detail}
          </span>
        )}
        {item.hint !== undefined && (
          <span className="mt-0.5 block text-meta italic leading-relaxed text-text-faint">
            {item.hint}
          </span>
        )}
      </div>
      {linked && <IconChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-text-faint" />}
    </>
  );
}
