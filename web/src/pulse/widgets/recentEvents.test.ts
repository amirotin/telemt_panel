import { describe, expect, it } from "vitest";
import { computeRecentEventsView } from "./recentEvents.helpers";
import type { RuntimeEdgeEvents } from "../../realtime/topics";

function events(overrides: Partial<RuntimeEdgeEvents> = {}): RuntimeEdgeEvents {
  return {
    capacity: 100,
    dropped_total: 0,
    events: [
      { seq: 1, ts_epoch_secs: 100, event_type: "config.reload", context: "" },
      { seq: 3, ts_epoch_secs: 300, event_type: "user.create", context: "alice" },
      { seq: 2, ts_epoch_secs: 200, event_type: "admission.closed", context: "" },
    ],
    ...overrides,
  };
}

describe("computeRecentEventsView", () => {
  it("sorts newest (highest seq) first", () => {
    const view = computeRecentEventsView(events());
    expect(view.events.map((e) => e.seq)).toEqual([3, 2, 1]);
  });

  it("caps at the given limit", () => {
    const view = computeRecentEventsView(events(), 2);
    expect(view.events).toHaveLength(2);
    expect(view.events.map((e) => e.seq)).toEqual([3, 2]);
  });

  it("carries dropped_total through", () => {
    expect(computeRecentEventsView(events({ dropped_total: 5 })).droppedTotal).toBe(5);
  });
});
