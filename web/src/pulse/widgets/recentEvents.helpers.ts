import type { RuntimeEdgeEventRecord, RuntimeEdgeEvents } from "../../realtime/topics";
import { localeOf, type Dict } from "../../i18n";

export interface RecentEventsView {
  events: RuntimeEdgeEventRecord[];
  droppedTotal: number;
}

/** How many rows concept §15's timeline shows before «Все события →». */
export const TIMELINE_LIMIT = 5;

// computeRecentEventsView returns the newest events first (Telemt's own
// events/recent already lists them oldest-first per seq, matching a normal
// log — the compact feed widget wants most-recent-on-top). The SDK
// normalizes every decoded slice to non-nil (internal/telemt/normalize.go,
// mini-task 2c) before it ever reaches the hub, so `events` is always a
// real (possibly empty) array on the wire — no defensive `?? []` needed here.
export function computeRecentEventsView(
  payload: RuntimeEdgeEvents,
  limit = TIMELINE_LIMIT,
): RecentEventsView {
  return {
    events: [...payload.events].sort((a, b) => b.seq - a.seq).slice(0, limit),
    droppedTotal: payload.dropped_total,
  };
}

/**
 * Concept §15's six icon categories, plus the neutral dot everything else
 * gets. `neutral` is not a failure of the mapping: Telemt's event types are
 * unbounded (`api.user.create.ok` is one of a family that grows with every
 * verb), so an unrecognised type has to render as a real row with a plain
 * marker rather than be forced into the nearest category.
 */
export type EventCategory =
  | "reload"
  | "listener"
  | "routing"
  | "user"
  | "warning"
  | "error"
  | "neutral";

/** Concept §15's colour rule: neutral, except warning, error and success. */
export type EventTone = "neutral" | "warn" | "error" | "ok";

// Telemt spells an event type as dot-separated segments — `config.reload
// .applied`, `admission.state`, `api.user.create.ok`. The OUTCOME lives in
// the last segment and the subject in the first, so both ends are read
// rather than the whole string matched.
function segments(eventType: string): { head: string; tail: string; all: string[] } {
  const all = eventType.toLowerCase().split(".").filter(Boolean);
  return { head: all[0] ?? "", tail: all.at(-1) ?? "", all };
}

const ERROR_OUTCOMES = new Set(["fail", "failed", "failure", "error", "err", "denied", "rejected"]);
const WARN_OUTCOMES = new Set(["warn", "warning", "degraded", "timeout", "dropped", "retry"]);
const OK_OUTCOMES = new Set(["ok", "applied", "success", "succeeded", "started", "ready"]);

const RELOAD_SUBJECTS = new Set(["config", "reload", "restart", "shutdown"]);
const LISTENER_SUBJECTS = new Set(["admission", "listener", "listen", "bind", "web"]);
const ROUTING_SUBJECTS = new Set(["route", "routing", "reroute", "upstream", "upstreams", "me", "dc", "fallback"]);
const USER_SUBJECTS = new Set(["user", "users", "api", "auth", "session"]);

/**
 * The icon an event gets. Outcome first: a `config.reload.failed` is an
 * error before it is a reload, because the marker's job on a timeline is to
 * say which rows need reading.
 */
export function eventCategory(eventType: string): EventCategory {
  const { head, tail, all } = segments(eventType);
  if (ERROR_OUTCOMES.has(tail)) return "error";
  if (WARN_OUTCOMES.has(tail)) return "warning";
  if (all.some((part) => RELOAD_SUBJECTS.has(part)) || RELOAD_SUBJECTS.has(head)) return "reload";
  if (all.some((part) => LISTENER_SUBJECTS.has(part))) return "listener";
  if (all.some((part) => ROUTING_SUBJECTS.has(part))) return "routing";
  if (all.some((part) => USER_SUBJECTS.has(part))) return "user";
  return "neutral";
}

/** §15: «Большинство событий — нейтральный текст», colour only at the edges. */
export function eventTone(eventType: string): EventTone {
  const { tail } = segments(eventType);
  if (ERROR_OUTCOMES.has(tail)) return "error";
  if (WARN_OUTCOMES.has(tail)) return "warn";
  if (OK_OUTCOMES.has(tail)) return "ok";
  return "neutral";
}

/**
 * The timeline's `HH:MM` stamp. Explicitly 24-hour in both languages: the
 * rail's whole point is that five stamps line up as five equal-width
 * columns, and an English «9:43 PM» breaks that alignment for no gain to an
 * operator reading a server log.
 */
export function eventTime(tsEpochSecs: number, s: Dict): string {
  return new Date(tsEpochSecs * 1000).toLocaleTimeString(localeOf(s), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
