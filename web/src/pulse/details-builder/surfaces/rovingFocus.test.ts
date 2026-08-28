import { describe, expect, it } from "vitest";
import { nextRovingIndex } from "./rovingFocus";

// The key map of §21's roving tabindex. The hook itself is exercised
// through the real components (DetailPage.responsive.test.tsx: the entity
// strip, the tablist and a ranking's rows); this pins the pure rule.

describe("nextRovingIndex", () => {
  it("moves along the group's own axis and ignores the other one", () => {
    expect(nextRovingIndex("ArrowRight", 0, 3, "horizontal")).toBe(1);
    expect(nextRovingIndex("ArrowLeft", 1, 3, "horizontal")).toBe(0);
    expect(nextRovingIndex("ArrowDown", 0, 3, "horizontal")).toBeNull();

    expect(nextRovingIndex("ArrowDown", 0, 3, "vertical")).toBe(1);
    expect(nextRovingIndex("ArrowUp", 1, 3, "vertical")).toBe(0);
    expect(nextRovingIndex("ArrowRight", 0, 3, "vertical")).toBeNull();
  });

  it("wraps at both ends", () => {
    expect(nextRovingIndex("ArrowRight", 2, 3, "horizontal")).toBe(0);
    expect(nextRovingIndex("ArrowLeft", 0, 3, "horizontal")).toBe(2);
  });

  it("jumps to the ends with Home and End", () => {
    expect(nextRovingIndex("Home", 2, 3, "vertical")).toBe(0);
    expect(nextRovingIndex("End", 0, 3, "vertical")).toBe(2);
  });

  it("claims no key at all for an empty group, and none it does not own", () => {
    expect(nextRovingIndex("ArrowDown", 0, 0, "vertical")).toBeNull();
    expect(nextRovingIndex("Enter", 0, 3, "vertical")).toBeNull();
    expect(nextRovingIndex("Tab", 0, 3, "vertical")).toBeNull();
  });
});
