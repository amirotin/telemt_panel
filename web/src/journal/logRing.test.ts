import { describe, expect, it } from "vitest";
import {
  LOG_RING_CAP,
  createJournalState,
  journalReducer,
  pendingCount,
  type JournalState,
} from "./logRing";
import type { LogLine } from "../lib/api/generated/types.gen";

function line(msg: string, overrides: Partial<LogLine> = {}): LogLine {
  return { ts: "2026-08-25T12:00:00Z", level: "info", msg, ...overrides };
}

function pushLines(state: JournalState, msgs: string[]): JournalState {
  return msgs.reduce((s, msg) => journalReducer(s, { type: "line", line: line(msg) }), state);
}

describe("journalReducer — ring buffer", () => {
  it("keeps lines in arrival order", () => {
    const state = pushLines(createJournalState(), ["a", "b", "c"]);
    expect(state.lines.map((l) => l.msg)).toEqual(["a", "b", "c"]);
    // ids are monotonic regardless of any ts collision.
    expect(state.lines.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it("caps at LOG_RING_CAP, dropping the oldest lines first", () => {
    const msgs = Array.from({ length: LOG_RING_CAP + 5 }, (_, i) => `line-${i}`);
    const state = pushLines(createJournalState(), msgs);
    expect(state.lines).toHaveLength(LOG_RING_CAP);
    expect(state.lines[0]?.msg).toBe("line-5");
    expect(state.lines[state.lines.length - 1]?.msg).toBe(`line-${LOG_RING_CAP + 4}`);
  });

  it("clear empties the ring", () => {
    const state = journalReducer(pushLines(createJournalState(), ["a", "b"]), { type: "clear" });
    expect(state.lines).toEqual([]);
  });
});

describe("journalReducer — pause/resume", () => {
  it("buffers incoming lines into pending while paused, leaving lines untouched", () => {
    let state = pushLines(createJournalState(), ["a"]);
    state = journalReducer(state, { type: "pause" });
    state = pushLines(state, ["b", "c"]);

    expect(state.paused).toBe(true);
    expect(state.lines.map((l) => l.msg)).toEqual(["a"]);
    expect(state.pending.map((l) => l.msg)).toEqual(["b", "c"]);
    expect(pendingCount(state)).toBe(2);
  });

  it("resume flushes pending into lines in order and clears the counter", () => {
    let state = pushLines(createJournalState(), ["a"]);
    state = journalReducer(state, { type: "pause" });
    state = pushLines(state, ["b", "c"]);
    state = journalReducer(state, { type: "resume" });

    expect(state.paused).toBe(false);
    expect(state.lines.map((l) => l.msg)).toEqual(["a", "b", "c"]);
    expect(pendingCount(state)).toBe(0);
  });

  it("resume with nothing pending just clears the paused flag", () => {
    let state = journalReducer(createJournalState(), { type: "pause" });
    state = journalReducer(state, { type: "resume" });
    expect(state.paused).toBe(false);
    expect(state.lines).toEqual([]);
  });

  it("pause/resume/pause is idempotent about re-entering the same state", () => {
    let state = journalReducer(createJournalState(), { type: "pause" });
    state = journalReducer(state, { type: "pause" });
    expect(state.paused).toBe(true);
  });

  it("the pending buffer is itself capped at LOG_RING_CAP while paused", () => {
    let state = journalReducer(createJournalState(), { type: "pause" });
    const msgs = Array.from({ length: LOG_RING_CAP + 5 }, (_, i) => `p-${i}`);
    state = pushLines(state, msgs);

    expect(state.pending).toHaveLength(LOG_RING_CAP);
    expect(state.pending[0]?.msg).toBe("p-5");
  });

  it("flushing an over-full pending buffer respects the ring cap on lines", () => {
    // Prime `lines` near the cap, then pause and overflow `pending` — the
    // resume flush must still leave `lines` at exactly LOG_RING_CAP,
    // keeping only the newest entries overall.
    let state = pushLines(createJournalState(), ["seed-a", "seed-b"]);
    state = journalReducer(state, { type: "pause" });
    const msgs = Array.from({ length: LOG_RING_CAP + 10 }, (_, i) => `p-${i}`);
    state = pushLines(state, msgs);
    state = journalReducer(state, { type: "resume" });

    expect(state.lines).toHaveLength(LOG_RING_CAP);
    expect(state.lines[state.lines.length - 1]?.msg).toBe(`p-${LOG_RING_CAP + 9}`);
  });

  it("clear while paused empties both lines and pending", () => {
    let state = pushLines(createJournalState(), ["a"]);
    state = journalReducer(state, { type: "pause" });
    state = pushLines(state, ["b"]);
    state = journalReducer(state, { type: "clear" });

    expect(state.lines).toEqual([]);
    expect(state.pending).toEqual([]);
    expect(state.paused).toBe(true);
  });
});
