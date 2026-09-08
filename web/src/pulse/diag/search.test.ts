import { describe, expect, it } from "vitest";
import { validateDetailSearch } from "./search";

describe("diagnostic URL search validation", () => {
  it("keeps entity and tab, and nothing else", () => {
    expect(validateDetailSearch({ entity: "dc:-203", tab: "writers", junk: 1 })).toEqual({
      entity: "dc:-203",
      tab: "writers",
    });
  });

  it("degrades junk and blank values to no selection", () => {
    expect(validateDetailSearch({ entity: 42, tab: null })).toEqual({});
    expect(validateDetailSearch({ entity: "   " })).toEqual({});
    expect(validateDetailSearch({})).toEqual({});
  });

  it("caps values before they enter browser history", () => {
    expect(validateDetailSearch({ entity: "x".repeat(1000) }).entity).toHaveLength(256);
  });
});
