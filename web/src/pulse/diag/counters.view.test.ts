import { describe, expect, it } from "vitest";
import type { ZeroAllData } from "../../lib/api/generated/types.gen";
import { zeroAll } from "../details-builder/__fixtures__";
import {
  breakdownRows,
  counterViewMetrics,
  readCounterViewValues,
  scalarCounterRows,
} from "./counters.view.helpers";

describe("Counters custom detail view", () => {
  it("keeps the first snapshot distinct from a quiet measured window", () => {
    expect(counterViewMetrics(undefined).connections).toBeNull();
    expect(counterViewMetrics({ "core.connections_total": 0 }).connections).toBe(0);
  });

  it("builds operator metrics from measured changes, not lifetime absolutes", () => {
    const metrics = counterViewMetrics({
      "core.connections_total": 4,
      "core.connections_bad_total": 0,
      "upstream.connect_attempt_total": 4,
      "upstream.connect_success_total": 4,
      "upstream.connect_fail_total": 0,
      "middle_proxy.d2c_payload_bytes_total": 24_448,
      "middle_proxy.route_drop_no_conn_total": 1,
    });
    expect(metrics.connections).toBe(4);
    expect(metrics.payloadBytes).toBe(24_448);
    expect(metrics.routeDrops).toBe(1);
    expect(metrics.newFailureSignals).toBe(1);
  });

  it("tracks breakdown classes for per-window failure causes", () => {
    const payload = {
      ...zeroAll,
      core: {
        ...zeroAll.core,
        connections_bad_by_class: [{ class: "timeout", total: 12 }],
      },
    } as unknown as ZeroAllData;
    expect(readCounterViewValues(payload)["core.connections_bad_by_class.timeout"]).toBe(12);
    expect(breakdownRows(payload.core["connections_bad_by_class"])).toEqual([
      { id: "timeout", total: 12 },
    ]);
  });

  it("keeps dynamic scalar fields while excluding nested breakdowns", () => {
    const rows = scalarCounterRows(zeroAll);
    expect(rows.some((row) => row.path === "core.core_0_total")).toBe(true);
    expect(rows.some((row) => row.path.includes("connections_bad_by_class"))).toBe(false);
  });
});
