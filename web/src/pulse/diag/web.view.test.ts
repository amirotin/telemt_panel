import { describe, expect, it } from "vitest";
import { webSessionRows } from "../__fixtures__/web";
import { webPagePayload } from "./web.helpers";
import { webStatusPartialPlanes, webStatusRunning } from "../__fixtures__/web";
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

  it("uses every observed resource and its process ceiling", () => {
    const payload = webPagePayload(structuredClone(webStatusRunning), null)!;
    payload.capacity = {
      http_connection_capacity_action: "wait",
      max_http_overload_connections: 4,
      http_overload_timeout_ms: 800,
      resources: [
        { resource: "http_connections", unit: "slots", used: 7, available: 1, limit: 8, closed: false },
        { resource: "pending_bytes", unit: "bytes", used: 900, available: 100, limit: 1000, closed: false },
        { resource: "queue_items", unit: "items", used: 3, available: 7, limit: 10, closed: false },
        { resource: "future_resource", unit: "credits", used: 2, available: 3, limit: 5, closed: false },
      ],
      saturated_resources: [],
      partial: [],
      rejections: [],
      http_connection_overload_outcomes: [],
    };
    const readings = webCapacityReadings(payload);
    expect(readings.find((item) => item.id === "http")).toMatchObject({ value: 7, limit: 8, resource: "http_connections", unit: "slots", available: 1, closed: false });
    expect(readings.find((item) => item.id === "queue")).toMatchObject({ value: 900, limit: 1000, bytes: true });
    expect(readings.find((item) => item.id === "queue_items")).toMatchObject({ value: 3, limit: 10, bytes: false });
    expect(readings.find((item) => item.id === "future_resource")).toMatchObject({ value: 2, limit: 5, bytes: false });
  });

  it("does not infer omitted resources from a contended capacity plane", () => {
    const payload = webPagePayload(structuredClone(webStatusRunning), null)!;
    payload.capacity = {
      http_connection_capacity_action: "drop", max_http_overload_connections: 4, http_overload_timeout_ms: 800,
      resources: [{ resource: "http_connections", unit: "slots", used: 8, available: 0, limit: 8, closed: true }],
      saturated_resources: ["http_connections"], partial: ["budget"], rejections: [], http_connection_overload_outcomes: [],
    };
    const readings = webCapacityReadings(payload);
    expect(readings.find((item) => item.id === "queue")).toBeUndefined();
    expect(readings.find((item) => item.id === "http")).toMatchObject({ value: 8, percent: null, tone: "busy" });
    expect(webHasCapacityPressure(readings, payload)).toBe(false);
  });

  it("includes WebSocket bytes in the legacy shared pending ceiling", () => {
    const payload = webPagePayload(structuredClone(webStatusRunning), null)!;
    payload.runtime!.budget!.queue_bytes = 20;
    payload.runtime!.budget!.websocket_bytes = 30;
    payload.runtime!.limits["pending_bytes_global"] = 100;
    expect(webCapacityReadings(payload).find((item) => item.id === "queue")).toMatchObject({ value: 50, limit: 100, percent: 50 });
  });

  it("uses current saturation instead of lifetime hits or approximate thresholds", () => {
    const payload = webPagePayload(structuredClone(webStatusRunning), null)!;
    payload.runtime!.limit_hits = 9;
    payload.capacity = {
      http_connection_capacity_action: "drop", max_http_overload_connections: 4, http_overload_timeout_ms: 800,
      resources: [{ resource: "http_connections", unit: "slots", used: 95, available: 5, limit: 100, closed: false }],
      saturated_resources: [], partial: [], rejections: [], http_connection_overload_outcomes: [],
    };
    expect(webHasCapacityPressure(webCapacityReadings(payload), payload)).toBe(false);
    payload.capacity.saturated_resources = ["future_resource"];
    expect(webHasCapacityPressure(webCapacityReadings(payload), payload)).toBe(true);
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
