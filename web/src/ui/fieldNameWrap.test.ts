import { describe, expect, it } from "vitest";
import { fieldNameSegments } from "./fieldNameWrap";

// The three names Task 8's review caught breaking mid-token at 360 px.
describe("fieldNameSegments", () => {
  it("offers a break after every underscore", () => {
    expect(fieldNameSegments("stun_backoff_remaining_ms")).toEqual([
      "stun_",
      "backoff_",
      "remaining_",
      "ms",
    ]);
    expect(fieldNameSegments("generated_at_epoch_secs")).toEqual([
      "generated_",
      "at_",
      "epoch_",
      "secs",
    ]);
  });

  it("keeps an index bracket with what follows it", () => {
    expect(fieldNameSegments("handshake_failures_by_class[]")).toEqual([
      "handshake_",
      "failures_",
      "by_",
      "class",
      "[]",
    ]);
  });

  it("breaks a nested path at its dots too", () => {
    expect(fieldNameSegments("reflection.v4.addr")).toEqual(["reflection.", "v4.", "addr"]);
  });

  it("leaves a name with nothing to break alone", () => {
    expect(fieldNameSegments("uptime")).toEqual(["uptime"]);
    // A human label already wraps on its spaces.
    expect(fieldNameSegments("Действующие лимиты")).toEqual(["Действующие лимиты"]);
  });

  it("never loses or reorders a character", () => {
    for (const name of [
      "stun_backoff_remaining_ms",
      "handshake_failures_by_class[]",
      "reflection.v4.addr",
      "_leading",
      "trailing_",
      "a[0].b_c",
    ]) {
      expect(fieldNameSegments(name).join("")).toBe(name);
    }
  });
});
