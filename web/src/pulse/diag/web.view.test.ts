import { describe, expect, it } from "vitest";
import { webSessionRows } from "../details-builder/__fixtures__/web";
import { webPagePayload } from "./web.helpers";
import { webStatusPartialPlanes, webStatusRunning } from "../details-builder/__fixtures__/web";
import {
  webCapacityReadings,
  webCapacityTone,
  webHasCapacityPressure,
  webRatio,
  webSessionMatches,
} from "./web.view.helpers";

describe("WEB custom detail view", () => {
  it("builds capacity from live values and their real limits", () => {
    const readings = webCapacityReadings(webPagePayload(webStatusRunning, null));
    expect(readings).toHaveLength(5);
    expect(readings.find((item) => item.id === "sessions")).toMatchObject({
      value: 0,
      limit: 128,
      percent: 0,
      tone: "calm",
    });
    expect(readings.find((item) => item.id === "http")).toMatchObject({
      value: 0,
      limit: 1024,
    });
  });

  it("does not turn a contended plane into a zero", () => {
    const readings = webCapacityReadings(webPagePayload(webStatusPartialPlanes, null));
    expect(readings.find((item) => item.id === "sessions")).toMatchObject({
      value: null,
      percent: null,
      tone: "busy",
    });
    expect(readings.find((item) => item.id === "queue")).toMatchObject({
      value: null,
      percent: null,
      tone: "busy",
    });
  });

  it("uses the approved 75 and 90 percent thresholds", () => {
    expect(webRatio(74, 100)).toBe(74);
    expect(webCapacityTone(74)).toBe("calm");
    expect(webCapacityTone(75)).toBe("warn");
    expect(webCapacityTone(90)).toBe("bad");
    expect(
      webHasCapacityPressure([
        { id: "sessions", value: 75, limit: 100, percent: 75, tone: "warn", bytes: false },
      ]),
    ).toBe(true);
  });

  it("filters sessions by state, carrier, and loaded-row search", () => {
    const row = webSessionRows[0]!;
    expect(webSessionMatches(row, "all", row.user)).toBe(true);
    expect(webSessionMatches(row, "https-lanes", "")).toBe(row.carrier === "https-lanes");
    expect(webSessionMatches(row, "all", "definitely-missing")).toBe(false);
  });
});
