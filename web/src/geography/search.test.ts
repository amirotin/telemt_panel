import { expect, it } from "vitest";
import { validateGeographySearch } from "./search";

it("normalizes UI parameters and excludes private paging identifiers", () => {
  expect(
    validateGeographySearch({
      range: "week",
      family: 9,
      view: "bad",
      country: "de",
      location: "<script>",
      snapshot_id: "private",
      cursor: "private",
    }),
  ).toEqual({ range: "now", family: "all", view: "map", country: null, location: null });
  expect(
    validateGeographySearch({
      range: "7d",
      family: 4,
      view: "globe",
      country: "JP",
      location: "city:JP:12",
    }),
  ).toEqual({ range: "7d", family: "4", view: "globe", country: "JP", location: "city:JP:12" });
});
