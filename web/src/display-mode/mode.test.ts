import { afterEach, describe, expect, it } from "vitest";
import { getStoredDisplayMode, setStoredDisplayMode, visibleFor } from "./mode";

describe("visibleFor", () => {
  it("orders critical < basic < extended", () => {
    expect(visibleFor("critical", "critical")).toBe(true);
    expect(visibleFor("basic", "critical")).toBe(false);
    expect(visibleFor("extended", "critical")).toBe(false);

    expect(visibleFor("critical", "basic")).toBe(true);
    expect(visibleFor("basic", "basic")).toBe(true);
    expect(visibleFor("extended", "basic")).toBe(false);

    expect(visibleFor("critical", "extended")).toBe(true);
    expect(visibleFor("basic", "extended")).toBe(true);
    expect(visibleFor("extended", "extended")).toBe(true);
  });
});

describe("display mode persistence", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to basic when nothing is stored", () => {
    expect(getStoredDisplayMode()).toBe("basic");
  });

  it("round-trips a stored value", () => {
    setStoredDisplayMode("extended");
    expect(getStoredDisplayMode()).toBe("extended");
    expect(localStorage.getItem("telemt-panel:display-mode:v1")).toBe("extended");
  });

  it("falls back to the default on a garbage stored value", () => {
    localStorage.setItem("telemt-panel:display-mode:v1", "not-a-mode");
    expect(getStoredDisplayMode()).toBe("basic");
  });

  it("falls back to the default when localStorage throws", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(getStoredDisplayMode()).toBe("basic");
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
