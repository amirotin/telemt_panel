import { expect, it } from "vitest";
import { alpha2ForNumeric, features, hasGeometry, numericForAlpha2 } from "./world";

it("joins the complete ISO mapping to atlas IDs, including leading zeroes", () => {
  expect(Object.keys(numericForAlpha2)).toHaveLength(249);
  expect(numericForAlpha2["AF"]).toBe("004");
  expect(alpha2ForNumeric(4)).toBe("AF");
  expect(alpha2ForNumeric("608")).toBe("PH");
  expect(alpha2ForNumeric("-99")).toBeNull();
  expect(hasGeometry("XK")).toBe(false);
  expect(hasGeometry("XX")).toBe(false);
  const missing = features.filter((f) => alpha2ForNumeric(f.id) === null).map((f) => String(f.id));
  expect([...new Set(missing)]).toEqual(["undefined"]);
});
