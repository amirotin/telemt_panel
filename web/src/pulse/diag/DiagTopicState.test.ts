import { describe, expect, it } from "vitest";
import { decideDiagTopicState } from "./DiagTopicState.helpers";

describe("decideDiagTopicState", () => {
  it("no data + no error + not stale -> skeleton", () => {
    expect(decideDiagTopicState(null, null, false)).toEqual({ kind: "skeleton" });
  });

  it("no data + no error + stale -> skeleton (stale is meaningless without data)", () => {
    expect(decideDiagTopicState(null, null, true)).toEqual({ kind: "skeleton" });
  });

  it("no data + error -> error, regardless of stale", () => {
    expect(decideDiagTopicState(null, "upstream_unreachable", false)).toEqual({ kind: "error" });
    expect(decideDiagTopicState(null, "upstream_unreachable", true)).toEqual({ kind: "error" });
  });

  it("undefined data + error -> error (field-level payload not yet decoded)", () => {
    expect(decideDiagTopicState(undefined, "internal_error", true)).toEqual({ kind: "error" });
  });

  it("data present + no error + not stale -> ready, not stale", () => {
    expect(decideDiagTopicState({ x: 1 }, null, false)).toEqual({ kind: "ready", stale: false });
  });

  it("data present + stale -> ready, stale", () => {
    expect(decideDiagTopicState({ x: 1 }, "upstream_unreachable", true)).toEqual({ kind: "ready", stale: true });
  });

  it("data present + error but not stale -> ready reflects the stale flag as given, not error", () => {
    // The SSE client always sets stale=true alongside a per-topic error
    // (sseClient.ts's applyTopicError), but this helper takes the two
    // flags independently so the matrix is exhaustive regardless of that
    // client-side coupling.
    expect(decideDiagTopicState({ x: 1 }, "upstream_unreachable", false)).toEqual({ kind: "ready", stale: false });
  });
});
