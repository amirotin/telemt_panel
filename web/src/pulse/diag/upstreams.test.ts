import { describe, expect, it } from "vitest";
import { mergeUpstreams, upstreamsPagePayload } from "./upstreams.helpers";
import { upstreams, upstreamQuality } from "../details-builder/__fixtures__";
import type { UpstreamStatus } from "../../realtime/topics";

function upstream(overrides: Partial<UpstreamStatus> = {}): UpstreamStatus {
  return {
    upstream_id: 0,
    route_kind: "direct",
    address: "direct",
    weight: 1,
    scopes: "all",
    healthy: true,
    fails: 0,
    last_check_age_secs: 12,
    effective_latency_ms: 41,
    dc: [],
    ...overrides,
  };
}

describe("mergeUpstreams (TELEMT_LIVE_API_DATA §7)", () => {
  it("folds the two endpoints' copies of one upstream into a single row", () => {
    const merged = mergeUpstreams(upstreams.upstreams, upstreamQuality.upstreams);
    expect(merged).toHaveLength(1);
    expect(merged[0].upstream_id).toBe(0);
    // The nested dc[] survives the merge intact — it is the block §23.5
    // wants rendered, not a casualty of joining two records.
    expect(merged[0].dc).toHaveLength(5);
  });

  it("prefers the stats copy and fills only what stats left null", () => {
    const merged = mergeUpstreams(
      [upstream({ effective_latency_ms: null, fails: 2 })],
      [upstream({ effective_latency_ms: 88, fails: 9 })],
    );
    expect(merged[0].effective_latency_ms).toBe(88);
    expect(merged[0].fails).toBe(2);
  });

  it("appends an upstream only the quality endpoint knows about, last", () => {
    const merged = mergeUpstreams([upstream({ upstream_id: 0 })], [upstream({ upstream_id: 7 })]);
    expect(merged.map((u) => u.upstream_id)).toEqual([0, 7]);
  });

  it("keys on upstream_id, not on position", () => {
    // The two endpoints have no reason to agree on order, and a fold that
    // zipped the arrays would silently graft one route's quality onto
    // another's stats. Same ids, reversed on the quality side:
    const merged = mergeUpstreams(
      [upstream({ upstream_id: 0, fails: 1 }), upstream({ upstream_id: 7, fails: 2 })],
      [
        upstream({ upstream_id: 7, address: "socks5://b:1080" }),
        upstream({ upstream_id: 0, address: "socks5://a:1080" }),
      ],
    );
    // Stats' order is the page's order, and each row kept its own partner.
    expect(merged.map((u) => u.upstream_id)).toEqual([0, 7]);
    expect(merged.map((u) => u.fails)).toEqual([1, 2]);
    // `address` is non-null on both sides, so stats wins — and the id that
    // matched is the one whose value survives.
    expect(merged.map((u) => u.address)).toEqual(["direct", "direct"]);
  });

  it("works with either half missing", () => {
    expect(mergeUpstreams(undefined, [upstream()])).toHaveLength(1);
    expect(mergeUpstreams([upstream()], undefined)).toHaveLength(1);
    expect(mergeUpstreams(undefined, undefined)).toEqual([]);
  });
});

describe("upstreamsPagePayload", () => {
  it("returns null when neither endpoint has answered", () => {
    expect(upstreamsPagePayload(null, null)).toBeNull();
    expect(upstreamsPagePayload(undefined, undefined)).toBeNull();
  });

  it("nests both response envelopes so neither borrows the DC domain's sentences", () => {
    const payload = upstreamsPagePayload(upstreams, upstreamQuality);
    expect(payload?.stats?.generated_at_epoch_secs).toBe(upstreams.generated_at_epoch_secs);
    expect(payload?.upstream_quality?.policy).toEqual(upstreamQuality.policy);
    // The bare spellings must NOT appear at the root: `reason` and
    // `generated_at_epoch_secs` are the DC domain's exact catalog keys.
    expect(Object.hasOwn(payload ?? {}, "reason")).toBe(false);
    expect(Object.hasOwn(payload ?? {}, "generated_at_epoch_secs")).toBe(false);
  });

  it("shows the four connect counters once, from stats", () => {
    const payload = upstreamsPagePayload(upstreams, upstreamQuality);
    expect(payload?.zero?.connect_attempt_total).toBe(upstreams.zero.connect_attempt_total);
    expect(payload?.zero?.connect_attempts_bucket_1).toBe(upstreams.zero.connect_attempts_bucket_1);
  });

  it("falls back to quality's four counters when the stats half is unavailable", () => {
    const payload = upstreamsPagePayload(null, upstreamQuality);
    expect(payload?.zero?.connect_attempt_total).toBe(upstreamQuality.counters.connect_attempt_total);
    // …and says nothing about the twelve buckets it does not have.
    expect(payload?.zero?.connect_attempts_bucket_1).toBeUndefined();
    expect(payload?.summary).toEqual(upstreamQuality.summary);
  });
});
