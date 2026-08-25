import { describe, expect, it } from "vitest";
import { AUTOSCROLL_THRESHOLD_PX, isScrolledToBottom } from "./autoscroll.helpers";

describe("isScrolledToBottom", () => {
  it("is true when scrolled exactly to the bottom", () => {
    expect(isScrolledToBottom(500, 300, 800)).toBe(true);
  });

  it("is true within the threshold slop", () => {
    expect(isScrolledToBottom(500 - AUTOSCROLL_THRESHOLD_PX, 300, 800)).toBe(true);
  });

  it("is false once scrolled up past the threshold", () => {
    expect(isScrolledToBottom(500 - AUTOSCROLL_THRESHOLD_PX - 1, 300, 800)).toBe(false);
  });

  it("is true when content doesn't overflow the viewport at all", () => {
    expect(isScrolledToBottom(0, 800, 300)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(isScrolledToBottom(400, 300, 800, 200)).toBe(true);
    expect(isScrolledToBottom(400, 300, 800, 50)).toBe(false);
  });
});
