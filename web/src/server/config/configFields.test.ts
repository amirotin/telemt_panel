import { describe, expect, it } from "vitest";
import { unknownKeysInSection } from "./configFields";

describe("unknownKeysInSection", () => {
  it("returns nothing when every key is known", () => {
    expect(unknownKeysInSection("general", { use_middle_proxy: true, ad_tag: "x" })).toEqual([]);
  });

  it("lists a key not in the catalog", () => {
    expect(unknownKeysInSection("general", { use_middle_proxy: true, mystery_field: 1 })).toEqual([
      "mystery_field",
    ]);
  });

  it("returns nothing for a non-object section value", () => {
    expect(unknownKeysInSection("general", undefined)).toEqual([]);
    expect(unknownKeysInSection("general", null)).toEqual([]);
    expect(unknownKeysInSection("general", [1, 2])).toEqual([]);
  });

  it("treats a section with no catalog entries as fully unknown", () => {
    expect(unknownKeysInSection("server", { listeners: [] })).toEqual(["listeners"]);
  });
});
