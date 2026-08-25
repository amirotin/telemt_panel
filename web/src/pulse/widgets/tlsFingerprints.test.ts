import { describe, expect, it } from "vitest";
import { topFingerprints } from "./tlsFingerprints.helpers";
import type { RuntimeEdgeTLSFingerprints } from "../../realtime/topics";

function row(ja3: string, total: number) {
  return { ja3, ja3_raw: "", ja4: "", ja4_raw: "", total, auth_success: 0, bad_or_probe: 0, first_seen_epoch_secs: 0, last_seen_epoch_secs: 0 };
}

function payload(overrides: Partial<RuntimeEdgeTLSFingerprints> = {}): RuntimeEdgeTLSFingerprints {
  return {
    limit: 100,
    retention_secs: 3600,
    capacity: 1000,
    dropped_total: 0,
    parse_error_total: 0,
    by_fingerprint: [row("a", 10), row("b", 30), row("c", 20)],
    by_ip: [],
    by_cidr: [],
    by_user: [],
    ...overrides,
  };
}

describe("topFingerprints", () => {
  it("sorts by_fingerprint descending by total", () => {
    expect(topFingerprints(payload()).map((r) => r.ja3)).toEqual(["b", "c", "a"]);
  });

  it("caps at the given limit", () => {
    expect(topFingerprints(payload(), 2)).toHaveLength(2);
  });

  it("is empty when by_fingerprint is empty", () => {
    expect(topFingerprints(payload({ by_fingerprint: [] }))).toEqual([]);
  });

  it("degrades to empty for a null by_fingerprint (nil Go slice on the wire)", () => {
    expect(topFingerprints(payload({ by_fingerprint: null }))).toEqual([]);
  });
});
