import { describe, expect, it } from "vitest";
import { events } from "../__fixtures__";
import {
  EVENT_FAMILY_OTHER,
  eventFamily,
  eventTypeCount,
  orderedEvents,
} from "./events.helpers";

describe("event view helpers", () => {
  it("orders newest first without mutating the payload", () => {
    const before = [...events.events];
    const ordered = orderedEvents(events.events);
    expect(ordered.map((event) => event.seq)).toEqual(
      [...ordered].map((event) => event.seq).sort((a, b) => b - a),
    );
    expect(events.events).toEqual(before);
  });

  it("keeps the known families and makes future event types reachable", () => {
    expect(eventFamily("admission.connection.open")).toBe("admission");
    expect(eventFamily("config.reload.ok")).toBe("config");
    expect(eventFamily("api.user.create.ok")).toBe("api");
    expect(eventFamily("future.new.event")).toBe(EVENT_FAMILY_OTHER);
  });

  it("distinguishes no response from an empty event buffer", () => {
    expect(eventTypeCount(undefined)).toBeNull();
    expect(eventTypeCount([])).toBe(0);
    expect(eventTypeCount(events.events)).toBe(3);
  });
});
