import { describe, expect, it } from "vitest";
import { en, ru } from "../../i18n/testing";
import { duration } from "./security.view.helpers";

describe("security duration", () => {
  it.each([
    [0, "0 s", "0 с"],
    [59, "59 s", "59 с"],
    [60, "1 min", "1 мин"],
    [61, "61 s", "61 с"],
    [120, "2 min", "2 мин"],
    [3600, "60 min", "60 мин"],
    [1.5, "1.5 s", "1,5 с"],
    [-60, "-60 s", "-60 с"],
  ])("preserves exact units and locale for %s seconds", (seconds, english, russian) => {
    expect(duration(en, seconds)).toBe(english);
    expect(duration(ru, seconds)).toBe(russian);
  });
});
