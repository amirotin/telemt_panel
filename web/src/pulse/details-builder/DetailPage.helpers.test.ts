import { describe, expect, it } from "vitest";
import { sectionsForTab, withUnknownTail } from "./DetailPage.helpers";
import type { SectionInstance } from "./resolveSections";

function section(id: string): SectionInstance {
  return {
    kind: "scalars",
    id,
    title: () => id,
    defaultExpanded: true,
    path: "",
    consumed: [],
    rows: [],
  };
}

const tail: SectionInstance = {
  kind: "unknownFields",
  id: "unknown-fields",
  title: () => "unknown",
  defaultExpanded: false,
  path: "",
  consumed: [],
  nodes: [],
  rawJson: true,
  leafPaths: [],
};

describe("withUnknownTail", () => {
  it("puts the tail last, so §27.4's third term is on screen", () => {
    const out = withUnknownTail([section("a"), section("b")], tail);
    expect(out.map((s) => s.id)).toEqual(["a", "b", "unknown-fields"]);
  });

  it("changes nothing when there is no tail", () => {
    expect(withUnknownTail([section("a")], null).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("sectionsForTab", () => {
  const sections = [section("a"), section("b"), section("c")];

  it("shows only the sections a tab claims", () => {
    const tabs = [
      { id: "one", label: () => "One", sections: ["a"] },
      { id: "two", label: () => "Two", sections: ["b", "c"] },
    ];
    expect(sectionsForTab(sections, tabs, "two").map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("gives a tab with no list everything no other tab claimed", () => {
    const tabs = [
      { id: "overview", label: () => "Overview" },
      { id: "detail", label: () => "Detail", sections: ["b"] },
    ];
    expect(sectionsForTab(sections, tabs, "overview").map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("falls back to the first tab when the URL names one that is gone", () => {
    const tabs = [
      { id: "one", label: () => "One", sections: ["a"] },
      { id: "two", label: () => "Two", sections: ["b"] },
    ];
    expect(sectionsForTab(sections, tabs, "removed").map((s) => s.id)).toEqual(["a"]);
  });

  it("keeps every section when a page declares no tabs at all", () => {
    expect(sectionsForTab(sections, [], undefined).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
