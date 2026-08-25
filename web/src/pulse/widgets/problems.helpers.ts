import { ru } from "../../i18n/ru";
import type { StatsSnapshot } from "../../realtime/topics";

export interface ProblemItem {
  key: string;
  label: string;
  detail?: string;
}

export interface StaleTopicInput {
  topic: string;
  stale: boolean;
  error: string | null;
}

// computeProblems ranks every currently-known problem worst-first: Telemt
// not ready, read-only mode, any topic reporting source_error/stale, ranked
// handshake failures by class (descending, zero-count classes dropped), then
// missing capabilities (06-ui.md's Проблемы widget: "handshake_failures_by_
// stage из summary, source_error топиков, Telemt not ready reason, read_only,
// capability gaps"). Returns [] when nothing is wrong — the widget then
// shows the "всё в порядке" empty state instead of an empty list.
export function computeProblems(
  stats: StatsSnapshot | null,
  staleTopics: StaleTopicInput[],
  missingCapabilities: string[],
): ProblemItem[] {
  const items: ProblemItem[] = [];

  if (stats?.ready && !stats.ready.ready) {
    items.push({ key: "not_ready", label: ru.pulse.problems.notReady, detail: stats.ready.reason });
  }
  if (stats?.health?.read_only) {
    items.push({ key: "read_only", label: ru.pulse.problems.readOnly });
  }
  for (const t of staleTopics) {
    if (t.stale || t.error) {
      items.push({
        key: `stale_${t.topic}`,
        label: `${ru.pulse.problems.staleTopic} ${t.topic}`,
        detail: t.error ?? undefined,
      });
    }
  }
  const failures = stats?.summary?.handshake_failures_by_class ?? [];
  for (const f of [...failures].sort((a, b) => b.total - a.total)) {
    if (f.total > 0) {
      items.push({
        key: `handshake_${f.class}`,
        label: `${ru.pulse.problems.handshakeFailures}: ${f.class}`,
        detail: String(f.total),
      });
    }
  }
  for (const cap of missingCapabilities) {
    items.push({ key: `cap_${cap}`, label: `${ru.pulse.problems.capabilityGap} ${cap}` });
  }

  return items;
}
