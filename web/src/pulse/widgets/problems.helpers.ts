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
// handshake failures by class (descending, zero-count classes dropped), the
// aggregate connections_bad_total/handshake_timeouts_total scalars (only
// when non-zero — stats.summary being entirely absent this poll must never
// be read as "zero problems", so these are only pushed when `stats.summary`
// itself is present), ranked connections_bad_by_class, then missing
// capabilities (06-ui.md's Проблемы widget: "handshake_failures_by_stage из
// summary, source_error топиков, Telemt not ready reason, read_only,
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
  // summary is a *SummaryData pointer that's null when this poll's sub-call
  // failed — guard the whole block on its presence so a transient fetch
  // failure never reads as "zero bad connections" (null ≠ zero).
  if (stats?.summary) {
    if (stats.summary.connections_bad_total > 0) {
      items.push({
        key: "connections_bad_total",
        label: ru.pulse.problems.connectionsBad,
        detail: String(stats.summary.connections_bad_total),
      });
    }
    if (stats.summary.handshake_timeouts_total > 0) {
      items.push({
        key: "handshake_timeouts_total",
        label: ru.pulse.problems.handshakeTimeouts,
        detail: String(stats.summary.handshake_timeouts_total),
      });
    }
  }
  const badByClass = stats?.summary?.connections_bad_by_class ?? [];
  for (const c of [...badByClass].sort((a, b) => b.total - a.total)) {
    if (c.total > 0) {
      items.push({
        key: `connections_bad_${c.class}`,
        label: `${ru.pulse.problems.connectionsBadByClass}: ${c.class}`,
        detail: String(c.total),
      });
    }
  }
  for (const cap of missingCapabilities) {
    items.push({ key: `cap_${cap}`, label: `${ru.pulse.problems.capabilityGap} ${cap}` });
  }

  return items;
}
