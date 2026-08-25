import { describe, expect, it } from "vitest";
import { countersGroups } from "./counters.helpers";
import { filterGroups } from "./rows";
import type { ZeroAllData } from "../../lib/api/generated/types.gen";

const data: ZeroAllData = {
  generated_at_epoch_secs: 100,
  core: { connections_total: 5, telemetry_me_level: "basic" },
  upstream: { connect_attempt_total: 3 },
  middle_proxy: { keepalive_sent_total: 1 },
  pool: { pool_swap_total: 0 },
  desync: { desync_total: 0 },
};

describe("countersGroups", () => {
  it("emits the five named sections in order", () => {
    expect(countersGroups(data).map((g) => g.title)).toEqual([
      "Ядро",
      "Апстримы",
      "Middle proxy",
      "Pool",
      "Desync",
    ]);
  });

  it("flattens each section's leaves", () => {
    const core = countersGroups(data)[0];
    expect(core.rows).toEqual([
      { key: "connections_total", label: "connections total", value: "5" },
      { key: "telemetry_me_level", label: "telemetry me level", value: "basic" },
    ]);
  });

  it("composes with filterGroups for the search box", () => {
    const groups = countersGroups(data);
    expect(filterGroups(groups, "keepalive").map((g) => g.title)).toEqual(["Middle proxy"]);
  });
});
