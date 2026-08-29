import { describe, expect, it } from "vitest";
import { connectionsPagePayload, usersTrafficTotal } from "./connections.helpers";
import { connectionsSummary, summary } from "../details-builder/__fixtures__";
import type { UsersTopic } from "../../realtime/topics";

const users = {
  users: [
    { username: "a", total_octets: 10 },
    { username: "b", total_octets: 32 },
  ],
} as unknown as UsersTopic;

describe("usersTrafficTotal", () => {
  it("sums every user's lifetime octets", () => {
    expect(usersTrafficTotal(users)).toBe(42);
  });

  it("returns null before the users topic has answered, never 0", () => {
    // A cumulative total rendered as "0 B" would be a claim the panel
    // cannot make yet (§13.1).
    expect(usersTrafficTotal(null)).toBeNull();
  });
});

describe("connectionsPagePayload", () => {
  it("returns null when neither half has answered", () => {
    expect(connectionsPagePayload(null, null, null)).toBeNull();
  });

  it("spreads the gated report's four blocks flat, as the catalog keys them", () => {
    const payload = connectionsPagePayload(summary, connectionsSummary, 42);
    expect(payload?.totals).toEqual(connectionsSummary.totals);
    expect(payload?.top?.by_connections).toHaveLength(10);
    expect(payload?.top?.by_throughput).toHaveLength(10);
    expect(payload?.cache).toEqual(connectionsSummary.cache);
    expect(payload?.telemetry).toEqual(connectionsSummary.telemetry);
    expect(payload?.users_traffic_total).toBe(42);
  });

  it("keeps the always-on half usable with the gate off (§14)", () => {
    const payload = connectionsPagePayload(summary, null, null);
    expect(payload?.summary).toEqual(summary);
    expect(payload?.totals).toBeUndefined();
    expect(Object.hasOwn(payload ?? {}, "users_traffic_total")).toBe(false);
  });
});
