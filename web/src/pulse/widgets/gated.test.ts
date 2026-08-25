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

  // F5 (closing fix wave): Telemt's actual wire behavior OMITS `data`
  // entirely when the gate is off (Go's `json:"data,omitempty"` on a nil
  // pointer) rather than sending an explicit null — resolveGated must
  // treat both shapes identically since either can arrive over the wire.
  it("treats an omitted data key the same as an explicit null, gate off", () => {
    const omitted = resolveGated({ enabled: false, reason: "off", generated_at_epoch_secs: 0 });
    const explicitNull = resolveGated({ enabled: false, reason: "off", generated_at_epoch_secs: 0, data: null });
    expect(omitted).toEqual(explicitNull);
    expect(omitted).toEqual({ status: "gated", reason: "off" });
  });

  it("treats an omitted data key the same as an explicit null, gate on but no payload yet", () => {
    const omitted = resolveGated({ enabled: true, generated_at_epoch_secs: 0 });
    const explicitNull = resolveGated({ enabled: true, generated_at_epoch_secs: 0, data: null });
    expect(omitted).toEqual(explicitNull);
    expect(omitted).toEqual({ status: "gated", reason: undefined });
  });
});
