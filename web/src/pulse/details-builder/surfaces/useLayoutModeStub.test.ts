import { describe, expect, it } from "vitest";
import { layoutModeFor, placementFor } from "./useLayoutModeStub";

// The §15.1 table and the §17 surface mapping, viewport by viewport. These
// are the thresholds Task 5 inherits: when the real useLayoutMode replaces
// this stub, this test moves with it rather than being deleted.

describe("layoutModeFor (spec §15.1)", () => {
  it.each([
    [360, 640, "compact-portrait"],
    [390, 844, "compact-portrait"],
    [640, 360, "compact-landscape"],
    [740, 360, "compact-landscape"],
    [844, 390, "compact-landscape"],
    [768, 1024, "medium"],
    [1024, 768, "wide"],
    [1366, 768, "wide"],
    [1920, 1080, "wide"],
    [1280, 900, "wide"],
  ])("%i×%i is %s", (width, height, expected) => {
    expect(layoutModeFor(width, height)).toBe(expected);
  });

  it("decides compact by HEIGHT even when the width would pass for a tablet", () => {
    // §15.3: "compact режим определяется высотой, даже если ширина 700–900".
    expect(layoutModeFor(880, 500)).toBe("compact-landscape");
    expect(layoutModeFor(880, 700)).not.toBe("compact-landscape");
  });

  it("needs both dimensions for wide — a tall narrow window is not desktop", () => {
    expect(layoutModeFor(899, 900)).toBe("medium");
    expect(layoutModeFor(900, 599)).toBe("medium");
    expect(layoutModeFor(900, 600)).toBe("wide");
  });
});

describe("placementFor (spec §17)", () => {
  it("bottom sheet in portrait, side sheet in landscape, modal on desktop", () => {
    expect(placementFor("compact-portrait")).toBe("bottom");
    expect(placementFor("compact-landscape")).toBe("side");
    expect(placementFor("medium")).toBe("modal");
    expect(placementFor("wide")).toBe("modal");
  });
});
