import { describe, expect, it } from "vitest";
import { events, initialization, initializationSkippedCount } from "../__fixtures__";
import { countStatuses, markerForTone, toneForStatus } from "./timeline.helpers";

describe("toneForStatus (spec §9.5)", () => {
  it("reads the statuses the production initialization fixture carries", () => {
    expect(toneForStatus("ready")).toBe("ok");
    expect(toneForStatus("skipped")).toBe("muted");
  });

  it("reads a dotted event type on its meaningful tail", () => {
    expect(toneForStatus("config.reload.applied")).toBe("ok");
    expect(toneForStatus("api.user.create.ok")).toBe("ok");
    expect(toneForStatus("me.writer.failed")).toBe("error");
  });

  it("gives an unknown status a NEUTRAL tone — never a warning it did not earn", () => {
    expect(toneForStatus("something_new_in_3_6")).toBe("neutral");
    // `admission.state` is what a healthy proxy emits all day long.
    expect(toneForStatus("admission.state")).toBe("neutral");
    expect(markerForTone("neutral")).not.toBe("");
  });

  it("is case- and whitespace-insensitive, because the word is data", () => {
    expect(toneForStatus("  READY ")).toBe("ok");
  });
});

describe("countStatuses", () => {
  it("summarizes the 16 initialization components as the render's header line", () => {
    const counts = countStatuses(initialization.components.map((c) => c.status));
    expect(counts).toEqual([
      { status: "ready", count: initialization.components.length - initializationSkippedCount },
      { status: "skipped", count: initializationSkippedCount },
    ]);
  });

  it("orders by count with an alphabetical tie-break, so the line does not reshuffle", () => {
    expect(countStatuses(["b", "a", "a", "c", "b"])).toEqual([
      { status: "a", count: 2 },
      { status: "b", count: 2 },
      { status: "c", count: 1 },
    ]);
  });

  it("summarizes the 50-event fixture by event type", () => {
    const counts = countStatuses(events.events.map((e) => e.event_type));
    expect(counts[0]).toEqual({ status: "admission.state", count: 48 });
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(events.events.length);
  });
});
