import { describe, expect, it } from "vitest";
import { buildMapModel, pointRadius } from "./mapModel";
import { location, overview } from "./testFixtures";

describe("one model for both map renderers", () => {
  it("bounds points and arcs while including an otherwise omitted selection", () => {
    const points = Array.from({ length: 201 }, (_, i) =>
      location(`city:DE:${String(i).padStart(3, "0")}`, 201 - i),
    );
    const selected = points[200];
    const data = overview({
      points,
      selection: selected,
      totals: { unique_ips: 30000, accounts: 2000, country_count: 100, location_count: 2000 },
      server: {
        state: "ready",
        origin: "manual",
        label: "Telemt",
        location: { latitude: 0, longitude: 0, accuracy_radius_km: null },
      },
    });
    const model = buildMapModel(data, { country: "DE", location: selected.id });
    expect(model.points).toHaveLength(200);
    expect(model.points.some((p) => p.id === selected.id)).toBe(true);
    expect(model.arcs).toHaveLength(40);
    expect(model.arcs.some((p) => p.id === selected.id)).toBe(true);
    expect(data.totals?.unique_ips).toBe(30000);
  });
  it("does not fabricate coordinates or server arcs", () => {
    const data = overview({ points: [{ ...location("city:DE:1"), location: null }] });
    const model = buildMapModel(data, { country: null, location: null });
    expect(model.points).toHaveLength(0);
    expect(model.arcs).toHaveLength(0);
    expect(pointRadius(0, 0)).toBe(4);
    expect(pointRadius(1, 100)).toBeLessThan(pointRadius(100, 100));
    expect(pointRadius(100, 100)).toBeLessThanOrEqual(16);
  });
});
