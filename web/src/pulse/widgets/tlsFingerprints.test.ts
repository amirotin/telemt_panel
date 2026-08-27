import { describe, expect, it } from "vitest";
import { resolveTlsFingerprintsQuery, topFingerprints } from "./tlsFingerprints.helpers";
import type { TlsFingerprints } from "../../lib/api/generated/types.gen";

function row(ja3: string, total: number) {
  return { ja3, ja3_raw: "", ja4: "", ja4_raw: "", total, auth_success: 0, bad_or_probe: 0, first_seen_epoch_secs: 0, last_seen_epoch_secs: 0 };
}

function payload(overrides: Partial<TlsFingerprints> = {}): TlsFingerprints {
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
});

describe("resolveTlsFingerprintsQuery", () => {
  it("is loading while pending", () => {
    expect(resolveTlsFingerprintsQuery({ isPending: true, isError: false })).toEqual({ status: "loading" });
  });

  it("maps the endpoint's 503 capability_unavailable to gated, not error", () => {
    expect(
      resolveTlsFingerprintsQuery({
        isPending: false,
        isError: true,
        error: { code: "capability_unavailable", message: "runtime_edge_enabled is off: feature_disabled" },
      }),
    ).toEqual({ status: "gated", reason: "runtime_edge_enabled is off: feature_disabled" });
  });

  it("maps an old build's 501 capability_absent to gated too", () => {
    expect(
      resolveTlsFingerprintsQuery({
        isPending: false,
        isError: true,
        error: { code: "capability_absent", message: "unsupported" },
      }).status,
    ).toBe("gated");
  });

  it("keeps a real failure an error so an outage stays visible", () => {
    expect(
      resolveTlsFingerprintsQuery({
        isPending: false,
        isError: true,
        error: { code: "telemt_unreachable", message: "could not reach telemt" },
      }),
    ).toEqual({ status: "error", code: "telemt_unreachable" });
  });

  it("falls back to internal_error when the envelope has no code", () => {
    expect(resolveTlsFingerprintsQuery({ isPending: false, isError: true, error: null })).toEqual({
      status: "error",
      code: "internal_error",
    });
  });

  it("treats a not-enabled 200 payload as gated, never as empty data", () => {
    expect(
      resolveTlsFingerprintsQuery({
        isPending: false,
        isError: false,
        data: { enabled: false, reason: "feature_disabled" },
      }),
    ).toEqual({ status: "gated", reason: "feature_disabled" });
  });

  it("unwraps the gated payload when enabled", () => {
    const data = payload();
    expect(resolveTlsFingerprintsQuery({ isPending: false, isError: false, data: { enabled: true, data } })).toEqual({
      status: "ok",
      data,
    });
  });
});
