import { describe, expect, it } from "vitest";
import { pushWindowEntry, readWindow, type WindowEntry } from "./topicWindow";

const MINUTE = 60_000;

function entry(ts: number, data: string): WindowEntry<string> {
  return { ts, data };
}

describe("pushWindowEntry", () => {
  it("appends in arrival order, oldest first", () => {
    let ring: WindowEntry<string>[] = [];
    ring = pushWindowEntry(ring, entry(1, "a"), 15 * MINUTE);
    ring = pushWindowEntry(ring, entry(2, "b"), 15 * MINUTE);
    ring = pushWindowEntry(ring, entry(3, "c"), 15 * MINUTE);
    expect(ring.map((e) => e.data)).toEqual(["a", "b", "c"]);
  });

  it("evicts entries older than the window relative to the newest one", () => {
    const base = 1_000_000;
    let ring: WindowEntry<string>[] = [];
    ring = pushWindowEntry(ring, entry(base, "old"), 15 * MINUTE);
    ring = pushWindowEntry(ring, entry(base + 10 * MINUTE, "mid"), 15 * MINUTE);
    ring = pushWindowEntry(ring, entry(base + 20 * MINUTE, "new"), 15 * MINUTE);
    expect(ring.map((e) => e.data)).toEqual(["mid", "new"]);
  });

  it("keeps an entry exactly on the window boundary", () => {
    const base = 1_000_000;
    let ring: WindowEntry<string>[] = [];
    ring = pushWindowEntry(ring, entry(base, "edge"), 15 * MINUTE);
    ring = pushWindowEntry(ring, entry(base + 15 * MINUTE, "new"), 15 * MINUTE);
    expect(ring.map((e) => e.data)).toEqual(["edge", "new"]);
  });

  it("ignores a duplicate timestamp and returns the same array reference", () => {
    const ring = pushWindowEntry([], entry(7, "a"), 15 * MINUTE);
    const again = pushWindowEntry(ring, entry(7, "a"), 15 * MINUTE);
    expect(again).toBe(ring);
    expect(again).toHaveLength(1);
  });

  it("caps the ring even when every entry is inside the window", () => {
    let ring: WindowEntry<number>[] = [];
    for (let i = 0; i < 400; i++) {
      ring = pushWindowEntry(ring, { ts: i, data: i }, 15 * MINUTE);
    }
    expect(ring).toHaveLength(256);
    expect(ring[ring.length - 1].data).toBe(399);
  });
});

describe("readWindow", () => {
  it("is empty before anything has arrived", () => {
    expect(readWindow([])).toEqual({ oldest: null, newest: null, size: 0 });
  });

  it("reports no oldest for a single snapshot — one reading is not a window", () => {
    const w = readWindow([entry(1, "a")]);
    expect(w.oldest).toBeNull();
    expect(w.newest?.data).toBe("a");
    expect(w.size).toBe(1);
  });

  it("returns the first and last entries once a window exists", () => {
    const w = readWindow([entry(1, "a"), entry(2, "b"), entry(3, "c")]);
    expect(w.oldest?.data).toBe("a");
    expect(w.newest?.data).toBe("c");
    expect(w.size).toBe(3);
  });
});
