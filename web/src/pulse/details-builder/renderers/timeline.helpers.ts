// Timeline step semantics (spec §9.5).
//
// A timeline step is a status word, a title, optional details and a
// duration or a moment. Telemt spells the status word itself — `ready`,
// `skipped`, `failed`, `open`, an event type — and §11.2's "the key is
// data" applies to it just as much: the word is printed verbatim, and only
// its TONE is interpreted here, so a status nobody has seen before still
// renders as a neutral step instead of disappearing.

/** Visual tone of a step's marker, mapped from the status word. */
export type TimelineTone = "ok" | "muted" | "warn" | "error";

const OK_STATUSES = new Set([
  "ready",
  "ok",
  "done",
  "complete",
  "completed",
  "success",
  "succeeded",
  "healthy",
  "open",
  "active",
  "applied",
]);

const MUTED_STATUSES = new Set(["skipped", "disabled", "inactive", "not_configured", "n/a"]);

const ERROR_STATUSES = new Set(["failed", "error", "fatal", "aborted", "rejected", "closed"]);

const WARN_STATUSES = new Set([
  "pending",
  "running",
  "in_progress",
  "starting",
  "retrying",
  "degraded",
  "partial",
  "warn",
  "stale",
]);

// toneForStatus reads the LAST dotted segment too, so `admission.state` and
// `config.reload.applied` — the event types the events fixture is made of —
// classify on their meaningful tail rather than on their namespace.
export function toneForStatus(status: string): TimelineTone {
  const word = status.trim().toLowerCase();
  const tail = word.includes(".") ? (word.split(".").pop() ?? word) : word;
  for (const candidate of [word, tail]) {
    if (OK_STATUSES.has(candidate)) return "ok";
    if (MUTED_STATUSES.has(candidate)) return "muted";
    if (ERROR_STATUSES.has(candidate)) return "error";
    if (WARN_STATUSES.has(candidate)) return "warn";
  }
  return "warn";
}

/** The glyph in the step's dot. Text, not an icon font — it is decorative. */
export function markerForTone(tone: TimelineTone): string {
  switch (tone) {
    case "ok":
      return "✓";
    case "muted":
      return "–";
    case "error":
      return "!";
    case "warn":
      return "•";
  }
}

export interface TimelineStatusCount {
  status: string;
  count: number;
}

// countStatuses builds the "14 ready · 2 skipped" line of the render. Order
// is by descending count with a stable alphabetical tie-break, so the line
// does not reshuffle between two frames that carry the same numbers.
export function countStatuses(statuses: readonly string[]): TimelineStatusCount[] {
  const counts = new Map<string, number>();
  for (const status of statuses) {
    const key = status.trim();
    if (key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}
