import { describe, expect, it } from "vitest";
import { computeProblems } from "./problems.helpers";
import type { StatsSnapshot } from "../../realtime/topics";

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { health: null, summary: null, ready: null, ...overrides };
}

describe("computeProblems", () => {
  it("returns nothing when there is nothing to report", () => {
    expect(computeProblems(null, [], [])).toEqual([]);
    expect(computeProblems(stats(), [], [])).toEqual([]);
  });

  it("reports not-ready with its reason first", () => {
    const items = computeProblems(
      stats({ ready: { ready: false, status: "not_ready", reason: "no upstreams", admission_open: false, healthy_upstreams: 0, total_upstreams: 1 } }),
      [],
      [],
    );
    expect(items[0]).toEqual({ key: "not_ready", label: "Telemt не готов", detail: "no upstreams" });
  });

  it("reports read_only", () => {
    const items = computeProblems(stats({ health: { status: "ok", read_only: true } }), [], []);
    expect(items.some((i) => i.key === "read_only")).toBe(true);
  });

  it("does not report not-ready when ready is true", () => {
    const items = computeProblems(
      stats({ ready: { ready: true, status: "ready", admission_open: true, healthy_upstreams: 1, total_upstreams: 1 } }),
      [],
      [],
    );
    expect(items).toEqual([]);
  });

  it("reports each stale/errored topic", () => {
    const items = computeProblems(
      stats(),
      [
        { topic: "runtime", stale: true, error: null },
        { topic: "security", stale: false, error: "telemt_unreachable" },
        { topic: "upstreams", stale: false, error: null },
      ],
      [],
    );
    expect(items.map((i) => i.key)).toEqual(["stale_runtime", "stale_security"]);
    expect(items[1].detail).toBe("telemt_unreachable");
  });

  it("ranks handshake failures descending by count and drops zero-count classes", () => {
    const items = computeProblems(
      stats({
        summary: {
          uptime_seconds: 0,
          connections_total: 0,
          connections_bad_total: 0,
          handshake_timeouts_total: 0,
          configured_users: 0,
          handshake_failures_by_class: [
            { class: "timeout", total: 3 },
            { class: "bad_secret", total: 10 },
            { class: "unused", total: 0 },
          ],
        },
      }),
      [],
      [],
    );
    expect(items.map((i) => i.key)).toEqual(["handshake_bad_secret", "handshake_timeout"]);
  });

  it("reports missing capabilities last", () => {
    const items = computeProblems(stats(), [], ["runtime_edge", "quota"]);
    expect(items.map((i) => i.key)).toEqual(["cap_runtime_edge", "cap_quota"]);
  });

  it("orders: not_ready, read_only, stale topics, handshake failures, capabilities", () => {
    const items = computeProblems(
      stats({
        ready: { ready: false, status: "not_ready", admission_open: false, healthy_upstreams: 0, total_upstreams: 1 },
        health: { status: "degraded", read_only: true },
        summary: {
          uptime_seconds: 0,
          connections_total: 0,
          connections_bad_total: 0,
          handshake_timeouts_total: 0,
          configured_users: 0,
          handshake_failures_by_class: [{ class: "timeout", total: 1 }],
        },
      }),
      [{ topic: "runtime", stale: true, error: null }],
      ["runtime_edge"],
    );
    expect(items.map((i) => i.key)).toEqual([
      "not_ready",
      "read_only",
      "stale_runtime",
      "handshake_timeout",
      "cap_runtime_edge",
    ]);
  });
});
