import { describe, expect, it } from "vitest";
import { computeActiveSessions } from "./activeSessions.helpers";
import type { StatsSnapshot } from "../../realtime/topics";

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { health: null, summary: null, ready: null, ...overrides };
}

describe("computeActiveSessions", () => {
  it("is loading when the topic hasn't loaded yet", () => {
    expect(computeActiveSessions(null)).toEqual({ status: "loading" });
  });

  it("is gated (no reason) when connections_summary is entirely absent", () => {
    expect(computeActiveSessions(stats())).toEqual({ status: "gated", reason: undefined });
  });

  it("is gated with the wire reason when the gate is explicitly closed", () => {
    const view = computeActiveSessions(
      stats({ connections_summary: { enabled: false, reason: "minimal runtime disabled", generated_at_epoch_secs: 0, data: null } }),
    );
    expect(view).toEqual({ status: "gated", reason: "minimal runtime disabled" });
  });

  it("is ok with the totals when enabled", () => {
    const view = computeActiveSessions(
      stats({
        connections_summary: {
          enabled: true,
          generated_at_epoch_secs: 0,
          data: {
            cache: { ttl_ms: 0, served_from_cache: false, stale_cache_used: false },
            totals: { current_connections: 10, current_connections_me: 6, current_connections_direct: 4, active_users: 8 },
            top: { limit: 0, by_connections: [], by_throughput: [] },
            telemetry: { user_enabled: false, throughput_is_cumulative: false },
          },
        },
      }),
    );
    expect(view).toEqual({ status: "ok", current: 10, viaMe: 6, direct: 4, activeUsers: 8 });
  });
});
