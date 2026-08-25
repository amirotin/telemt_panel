import type { LogLine } from "../lib/api/generated/types.gen";

// LOG_RING_CAP — the Journal tab's in-memory log buffer (Task 7 brief: "ring
// buffer of 2000 lines in tab memory"). Applies to both the visible ring and
// the pause buffer below (see journalReducer's "line" case) so pausing for a
// long time can't grow memory unbounded either.
export const LOG_RING_CAP = 2000;

// RingLine adds a client-assigned monotonic id — LogLine itself has no
// unique identifier, and two lines can legitimately share the same `ts`
// (second-granularity sources, or a fast burst) so React keys and stable
// oldest-to-newest ordering need something else to key off.
export interface RingLine extends LogLine {
  id: number;
}

export interface JournalState {
  /** Capped at LOG_RING_CAP, oldest-first — what the log list renders. */
  lines: RingLine[];
  paused: boolean;
  /** Lines received while paused, also capped at LOG_RING_CAP, oldest-first. */
  pending: RingLine[];
  nextId: number;
}

export type JournalAction =
  | { type: "line"; line: LogLine }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear" };

export function createJournalState(): JournalState {
  return { lines: [], paused: false, pending: [], nextId: 1 };
}

// capPush appends `item`, dropping from the front once length exceeds `cap`
// — the actual ring-buffer behavior shared by both `lines` and `pending`.
function capPush<T>(arr: T[], item: T, cap: number): T[] {
  const next = arr.length >= cap ? arr.slice(arr.length - cap + 1) : arr.slice();
  next.push(item);
  return next;
}

// journalReducer is the pure state machine behind the Logs tab's live
// buffer: while paused, incoming lines accumulate in `pending` (counted by
// pendingCount below) instead of `lines`, so the visible list — and the
// user's scroll position within it — never moves until they resume
// (Task 7 brief A: "пауза (клиентская): incoming lines buffered while
// paused, a counter «+N новых»; resume flushes").
export function journalReducer(state: JournalState, action: JournalAction): JournalState {
  switch (action.type) {
    case "line": {
      const line: RingLine = { ...action.line, id: state.nextId };
      const nextId = state.nextId + 1;
      if (state.paused) {
        return { ...state, pending: capPush(state.pending, line, LOG_RING_CAP), nextId };
      }
      return { ...state, lines: capPush(state.lines, line, LOG_RING_CAP), nextId };
    }
    case "pause":
      return state.paused ? state : { ...state, paused: true };
    case "resume": {
      if (!state.paused) return state;
      if (state.pending.length === 0) return { ...state, paused: false };
      let lines = state.lines;
      for (const line of state.pending) lines = capPush(lines, line, LOG_RING_CAP);
      return { ...state, paused: false, lines, pending: [] };
    }
    case "clear":
      return { ...state, lines: [], pending: [] };
    default:
      return state;
  }
}

export function pendingCount(state: JournalState): number {
  return state.pending.length;
}
