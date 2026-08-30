import type { RuntimeEdgeEventRecord, RuntimeEdgeEvents } from "../../realtime/topics";
import { fill, formatNumber, localeOf, type Dict } from "../../i18n";
import { formatDurationApprox } from "../../people/expiry";

/** How many rows concept §15's timeline shows before «Все события →». */
export const TIMELINE_LIMIT = 5;

/**
 * One timeline row: a RUN of consecutive events of the same type, collapsed.
 *
 * Telemt's ring is fifty slots and a flapping proxy fills it with one fact
 * repeated — the live panel showed five rows of «Приём клиентов открыт /
 * закрыт / открыт / закрыт / открыт», which is five rows saying one thing.
 * A run becomes one row stamped with its NEWEST event, counted, and spanned.
 */
export interface CoalescedEvent {
  /** The newest record of the run — the row's identity, stamp and detail. */
  latest: RuntimeEdgeEventRecord;
  /** The oldest record of the run — the "from" end of a state transition. */
  oldest: RuntimeEdgeEventRecord;
  /** How many records the row stands for; 1 means nothing was collapsed. */
  count: number;
}

export interface RecentEventsView {
  rows: CoalescedEvent[];
  droppedTotal: number;
}

/**
 * The grouping key. Telemt's `event_type` already carries the outcome in
 * its last segment (`config.reload.applied` vs `config.reload.failed`), so
 * one key is enough to keep a success and a failure of the same operation
 * apart while still folding a run of the same fact together.
 *
 * `admission.state` is the case that makes this worth doing: ONE type whose
 * context flips between open and closed, which is exactly the run the
 * timeline should state once, as a transition.
 */
export function coalesceKey(event: Pick<RuntimeEdgeEventRecord, "event_type">): string {
  return event.event_type.trim().toLowerCase();
}

/**
 * Collapses CONSECUTIVE same-key events, newest first. Consecutive only:
 * an unrelated event between two reloads means they were two separate
 * reloads, and merging across it would put a count on a run that never
 * happened.
 */
export function coalesceEvents(
  events: readonly RuntimeEdgeEventRecord[],
  limit = TIMELINE_LIMIT,
): CoalescedEvent[] {
  const rows: CoalescedEvent[] = [];
  for (const event of events) {
    const last = rows.at(-1);
    if (last && coalesceKey(last.latest) === coalesceKey(event)) {
      last.oldest = event;
      last.count += 1;
      continue;
    }
    if (rows.length === limit) break;
    rows.push({ latest: event, oldest: event, count: 1 });
  }
  return rows;
}

// computeRecentEventsView returns the newest events first (Telemt's own
// events/recent already lists them oldest-first per seq, matching a normal
// log — the compact feed widget wants most-recent-on-top), coalesced into
// at most `limit` rows. The SDK normalizes every decoded slice to non-nil
// (internal/telemt/normalize.go, mini-task 2c) before it ever reaches the
// hub, so `events` is always a real (possibly empty) array on the wire — no
// defensive `?? []` needed here.
export function computeRecentEventsView(
  payload: RuntimeEdgeEvents,
  limit = TIMELINE_LIMIT,
): RecentEventsView {
  const newestFirst = [...payload.events].sort((a, b) => b.seq - a.seq);
  return {
    rows: coalesceEvents(newestFirst, limit),
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
 * The timeline's `HH:MM` stamp. Explicitly 24-hour in both languages: an
 * English «9:43 PM» would be wider than every other stamp for no gain to an
 * operator reading a server log.
 */
export function eventTime(tsEpochSecs: number, s: Dict): string {
  return new Date(tsEpochSecs * 1000).toLocaleTimeString(localeOf(s), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * The full instant, for the row's `title`. The visible stamp is relative
 * («12 мин назад») because that is the question an operator actually has
 * about a five-row feed; the exact moment stays one hover away rather than
 * being dropped.
 */
export function eventTimestamp(tsEpochSecs: number, s: Dict): string {
  return new Date(tsEpochSecs * 1000).toLocaleString(localeOf(s), {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  });
}

/** Below this, "just now" is more honest than rounding up to a minute. */
const JUST_NOW_MS = 60_000;

/** «12 мин назад» — how long ago the row's newest event happened. */
export function eventAgo(tsEpochSecs: number, nowMs: number, s: Dict): string {
  const elapsed = nowMs - tsEpochSecs * 1000;
  if (elapsed < JUST_NOW_MS) return s.pulse.recentEvents.justNow;
  return fill(s.pulse.recentEvents.ago, { duration: formatDurationApprox(elapsed, s) });
}

/**
 * «×3 за 2 ч.» — what a collapsed row adds to the one event it shows.
 * `null` for a row that collapsed nothing: a «×1» on four rows out of five
 * is noise.
 */
export function eventRepeatText(row: CoalescedEvent, s: Dict): string | null {
  if (row.count < 2) return null;
  const span = (row.latest.ts_epoch_secs - row.oldest.ts_epoch_secs) * 1000;
  return fill(s.pulse.recentEvents.repeat, {
    count: formatNumber(s, row.count),
    span:
      span < JUST_NOW_MS
        ? s.pulse.recentEvents.spanShort
        : fill(s.pulse.recentEvents.span, { duration: formatDurationApprox(span, s) }),
  });
}

// --- the event, in words (concept §15) -----------------------------------

/** A key under `pulse.recentEvents.types` — one human sentence. */
export type EventPhraseKey = keyof Dict["pulse"]["recentEvents"]["types"];

/**
 * The rules that turn Telemt's own event type into a sentence, in order.
 *
 * A TABLE and not a free-form matcher: an event type is a contract, and the
 * only honest way to claim "this means the configuration was reloaded" is
 * to name the type that means it. The patterns are anchored on the OUTCOME
 * segment so a failed operation can never borrow its success sentence —
 * `api.user.create.failed` matches nothing here and stays verbatim, which
 * is also what every type this catalog has never seen does.
 *
 * `admission.state` is not in the table: its meaning is in the CONTEXT, so
 * it is read separately below.
 */
const EVENT_PHRASES: Array<readonly [RegExp, EventPhraseKey]> = [
  [/^config\.(reload|apply)(\.[a-z0-9_]+)*\.(applied|ok|success|done)$/, "configReloaded"],
  [/^config\.(reload|apply)(\.[a-z0-9_]+)*\.(fail|failed|failure|error)$/, "configReloadFailed"],
  [/^(process|runtime|service|proxy)\.restart(ed)?(\.(ok|done))?$/, "restarted"],
  [/(^|\.)listener\.(start|started|bound|up)$/, "listenerStarted"],
  [/(^|\.)listener\.(stop|stopped|closed|down)$/, "listenerStopped"],
  [/(^|\.)(reroute|fallback)\.(direct|active|on)$/, "routeFallback"],
  [/^me\.route\.fallback$/, "routeFallback"],
  [/(^|\.)(reroute|fallback)\.(middle|restored|off)$/, "routeRestored"],
  [/^me\.route\.restored$/, "routeRestored"],
  [/(^|\.)user\.(create|created)(\.(ok|success|done))?$/, "userCreated"],
  [/(^|\.)user\.(delete|deleted|remove|removed)(\.(ok|success|done))?$/, "userDeleted"],
  [/(^|\.)user\.(disable|disabled)(\.(ok|success|done))?$/, "userDisabled"],
  [/(^|\.)user\.(enable|enabled)(\.(ok|success|done))?$/, "userEnabled"],
];

export const ADMISSION_EVENT_TYPE = "admission.state";

/**
 * Whether `admission.state` is reporting an OPEN or a CLOSED door.
 *
 * Two spellings are in the wild for the same fact: the live proxies send
 * `generation=1 accepting_new_connections=true`, and the recorded API
 * snapshot the fixtures are built from sends `open (healthy_upstreams=1)`.
 * Anything else returns null and the row falls back to verbatim rather than
 * guessing which way the door is.
 */
export function admissionPhrase(context: string): EventPhraseKey | null {
  const flag = /accepting_new_connections\s*=\s*(true|false)/i.exec(context);
  if (flag) return flag[1]!.toLowerCase() === "true" ? "admissionOpen" : "admissionClosed";
  const word = /^\s*(open|closed)\b/i.exec(context);
  if (word) return word[1]!.toLowerCase() === "open" ? "admissionOpen" : "admissionClosed";
  return null;
}

/** The sentence key for one event, or null when this catalog has none. */
export function eventPhraseKey(event: Pick<RuntimeEdgeEventRecord, "event_type" | "context">): EventPhraseKey | null {
  const type = event.event_type.trim().toLowerCase();
  if (type === ADMISSION_EVENT_TYPE) return admissionPhrase(event.context);
  for (const [pattern, key] of EVENT_PHRASES) {
    if (pattern.test(type)) return key;
  }
  return null;
}

/**
 * Phrase keys that come in OPPOSING pairs — the two ends of one switch.
 *
 * A run of these is not «Приём клиентов открыт ×3»: the proxy went closed,
 * open, closed, open, and the row that says so is «Приём клиентов: закрыт →
 * открыт». Only pairs are listed — a run of «Конфигурация перезагружена»
 * has no other end to name and stays the sentence with a count on it.
 */
export type EventSubjectKey = keyof Dict["pulse"]["recentEvents"]["subjects"];
export type EventStateKey = keyof Dict["pulse"]["recentEvents"]["states"];

const PHRASE_PAIRS: Partial<Record<EventPhraseKey, { subject: EventSubjectKey; state: EventStateKey }>> = {
  admissionOpen: { subject: "admission", state: "open" },
  admissionClosed: { subject: "admission", state: "closed" },
  listenerStarted: { subject: "listener", state: "started" },
  listenerStopped: { subject: "listener", state: "stopped" },
  routeFallback: { subject: "route", state: "direct" },
  routeRestored: { subject: "route", state: "me" },
  userEnabled: { subject: "user", state: "enabled" },
  userDisabled: { subject: "user", state: "disabled" },
};

function phrasePairOf(
  event: Pick<RuntimeEdgeEventRecord, "event_type" | "context">,
): { subject: EventSubjectKey; state: EventStateKey } | undefined {
  const key = eventPhraseKey(event);
  return key === null ? undefined : PHRASE_PAIRS[key];
}

/** One timeline row's text: a sentence, and Telemt's own detail after it. */
export interface EventLine {
  text: string;
  /** Telemt's `context`, shown muted after the text; absent when the text already says it. */
  detail?: string;
}

/**
 * The row's text for a COALESCED run.
 *
 * When the run's two ends are opposite states of one subject, the row states
 * the transition — that is the only formulation that stays true of every
 * event it stands for. Otherwise the row is the newest event's own sentence,
 * exactly as an uncollapsed row would print it.
 */
export function coalescedLine(row: CoalescedEvent, s: Dict): EventLine {
  if (row.count > 1) {
    const from = phrasePairOf(row.oldest);
    const to = phrasePairOf(row.latest);
    if (from && to && from.subject === to.subject && from.state !== to.state) {
      return {
        text: fill(s.pulse.recentEvents.transition, {
          subject: s.pulse.recentEvents.subjects[from.subject],
          from: s.pulse.recentEvents.states[from.state],
          to: s.pulse.recentEvents.states[to.state],
        }),
      };
    }
  }
  return eventLine(row.latest, s);
}

/**
 * eventLine is what a row prints.
 *
 * A known type becomes the sentence, with the raw context kept beside it —
 * «Пользователь создан · username=user_15» — because the context is the
 * only place the WHICH lives. `admission.state` is the exception: its
 * context IS the fact the sentence already states, so repeating it would
 * make the row longer and say nothing.
 *
 * An unknown type keeps S3's verbatim shape, `event_type · context`: the
 * vocabulary grows with every API verb Telemt adds, and a row the panel
 * cannot phrase must still be a row the operator can read and search for.
 */
export function eventLine(event: RuntimeEdgeEventRecord, s: Dict): EventLine {
  const key = eventPhraseKey(event);
  const detail = event.context.trim();
  if (key === null) {
    return { text: event.event_type, ...(detail ? { detail } : {}) };
  }
  const text = s.pulse.recentEvents.types[key];
  if (key === "admissionOpen" || key === "admissionClosed") return { text };
  return { text, ...(detail ? { detail } : {}) };
}
