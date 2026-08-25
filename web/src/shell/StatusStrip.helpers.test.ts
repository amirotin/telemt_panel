import { describe, expect, it } from "vitest";
import { connectionsLabel, healthLabel, healthPillState, trafficLabel } from "./StatusStrip.helpers";
import type { StatsSnapshot } from "../realtime/topics";
import type { HistorySeries } from "../lib/api/generated/types.gen";
import { ru as s } from "../i18n";

describe("healthPillState", () => {
  it("is muted when there is no status yet", () => {
    expect(healthPillState(undefined)).toBe("muted");
  });

  it.each(["ok", "healthy"])("is ok for %s", (status) => {
    expect(healthPillState(status)).toBe("ok");
  });

  it("is warn while starting", () => {
    expect(healthPillState("starting")).toBe("warn");
  });

  it("is error for anything else", () => {
    expect(healthPillState("degraded")).toBe("error");
  });
});

describe("healthLabel", () => {
  it("falls back to the unknown label when there is no status yet", () => {
    expect(healthLabel(undefined, s)).toBe("Нет данных");
  });

  it.each(["ok", "healthy"])("shows the ok label for %s", (status) => {
    expect(healthLabel(status, s)).toBe("Работает");
  });

  it("shows the starting label while starting", () => {
    expect(healthLabel("starting", s)).toBe("Запускается");
  });

  it("shows the degraded label for anything else", () => {
    expect(healthLabel("degraded", s)).toBe("Деградация");
  });
});

describe("connectionsLabel", () => {
  it("is an em dash before any data has arrived", () => {
    expect(connectionsLabel(null, s)).toBe("—");
  });

  it("is an em dash when neither figure is present", () => {
    const data: StatsSnapshot = { health: null, summary: null, ready: null };
    expect(connectionsLabel(data, s)).toBe("—");
  });

  it("falls back to the cumulative summary total without runtime_edge", () => {
    const data: StatsSnapshot = {
      health: null,
      summary: {
        uptime_seconds: 1,
        connections_total: 42,
        connections_bad_total: 0,
        handshake_timeouts_total: 0,
        configured_users: 1,
      },
      ready: null,
    };
    expect(connectionsLabel(data, s)).toBe("42 соед.");
  });

  it("prefers the live runtime_edge total when enabled", () => {
    const data: StatsSnapshot = {
      health: null,
      summary: {
        uptime_seconds: 1,
        connections_total: 42,
        connections_bad_total: 0,
        handshake_timeouts_total: 0,
        configured_users: 1,
      },
      ready: null,
      connections_summary: {
        enabled: true,
        data: {
          cache: { ttl_ms: 0, served_from_cache: false, stale_cache_used: false },
          totals: {
            current_connections: 7,
            current_connections_me: 5,
            current_connections_direct: 2,
            active_users: 3,
          },
          top: { limit: 0, by_connections: [], by_throughput: [] },
          telemetry: { user_enabled: false, throughput_is_cumulative: false },
        },
      },
    };
    expect(connectionsLabel(data, s)).toBe("7 соед.");
  });

  it("falls back to the summary total when connections_summary is gated off", () => {
    const data: StatsSnapshot = {
      health: null,
      summary: {
        uptime_seconds: 1,
        connections_total: 42,
        connections_bad_total: 0,
        handshake_timeouts_total: 0,
        configured_users: 1,
      },
      ready: null,
      connections_summary: { enabled: false, reason: "runtime_edge disabled", data: null },
    };
    expect(connectionsLabel(data, s)).toBe("42 соед.");
  });
});

describe("trafficLabel", () => {
  function series(points: Array<{ ts: number; v: number }>): HistorySeries {
    return { metric: "traffic", range: "15m", points };
  }

  it("falls back to н/д before any history has loaded", () => {
    expect(trafficLabel(undefined, s)).toBe("н/д");
  });

  it("falls back to н/д when the 15-min ring genuinely has no points", () => {
    expect(trafficLabel(series([]), s)).toBe("н/д");
  });

  it("formats the latest point with formatBytes — the same figure StatRow's traffic row shows", () => {
    expect(trafficLabel(series([{ ts: 1, v: 1024 }, { ts: 2, v: 50_233 }]), s)).toBe("49 КБ");
  });
});
