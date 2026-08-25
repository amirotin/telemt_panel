import { useSnapshot } from "../../realtime";
import type { StatsSnapshot } from "../../realtime/topics";
import { useCaps } from "../../caps";
import { EmptyState } from "../../ui/EmptyState";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { computeProblems, type StaleTopicInput } from "./problems.helpers";

// Problems — a ranked list of everything currently wrong (06-ui.md), or the
// "всё в порядке" empty state. Non-hideable in the default layout's spirit
// but still technically hideable=true per registry.ts (the layout editor
// lets an operator hide it like any other widget — only health_hero is
// pinned).
export function Problems({ onHide }: { onHide?: () => void }) {
  const stats = useSnapshot<StatsSnapshot>("stats");
  const runtime = useSnapshot("runtime");
  const upstreams = useSnapshot("upstreams");
  const security = useSnapshot("security");
  const caps = useCaps();

  if (!stats.data) {
    return (
      <WidgetFrame title={ru.pulse.widgets.problems} onHide={onHide}>
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

  const items = computeProblems(stats.data, staleTopics, missingCapabilities);

  if (items.length === 0) {
    return (
      <WidgetFrame title={ru.pulse.widgets.problems} onHide={onHide}>
        <EmptyState title={ru.pulse.problems.none} description={ru.pulse.problems.noneDescription} />
      </WidgetFrame>
    );
  }

  return (
    <WidgetFrame title={ru.pulse.widgets.problems} onHide={onHide}>
      <ul className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <li key={item.key} className="flex items-baseline justify-between gap-3 py-2 text-sm">
            <span className="text-text">{item.label}</span>
            {item.detail && (
              <span className="shrink-0 truncate text-xs text-text-muted">{item.detail}</span>
            )}
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}
