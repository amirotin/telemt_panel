import { describe, expect, it } from "vitest";
import { resolveGated } from "./gated";

describe("resolveGated", () => {
  it("is gated with no reason when the wrapper itself is null (sub-call failed this poll)", () => {
    expect(resolveGated(null)).toEqual({ status: "gated", reason: undefined });
  });

  it("is gated with no reason when the wrapper is undefined (omitted — capability off)", () => {
    expect(resolveGated(undefined)).toEqual({ status: "gated", reason: undefined });
  });

  it("is gated with the wire reason when enabled:false", () => {
    expect(resolveGated({ enabled: false, reason: "minimal runtime disabled", generated_at_epoch_secs: 0, data: null })).toEqual({
      status: "gated",
      reason: "minimal runtime disabled",
    });
  });

  it("is gated when enabled:true but data is somehow still null", () => {
    expect(resolveGated({ enabled: true, generated_at_epoch_secs: 0, data: null })).toEqual({
      status: "gated",
      reason: undefined,
    });
  });

  it("is ok with the payload when enabled and data is present", () => {
    expect(resolveGated({ enabled: true, generated_at_epoch_secs: 0, data: { x: 1 } })).toEqual({
      status: "ok",
      data: { x: 1 },
    });
  });
});
