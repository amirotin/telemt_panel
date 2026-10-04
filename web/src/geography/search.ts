import type { GeographyFamily, GeographyRange } from "../lib/api/generated/types.gen";

export type GeographySearch = { range: GeographyRange; family: GeographyFamily; view: "map" | "globe"; country: string | null; location: string | null };
export function validateGeographySearch(input: Record<string, unknown>): GeographySearch {
  const range = ["now","24h","7d","30d"].includes(String(input["range"])) ? input["range"] as GeographyRange : "now";
  const rawFamily = String(input["family"]);
  const family = ["all","4","6"].includes(rawFamily) ? rawFamily as GeographyFamily : "all";
  const country = typeof input["country"] === "string" && /^[A-Z]{2}$/.test(input["country"]) ? input["country"] : null;
  const location = typeof input["location"] === "string" && input["location"].length <= 160 && /^(city:[A-Z]{2}:[1-9]\d*|point:[A-Z]{2}:-?\d+\.\d{4}:-?\d+\.\d{4}|country-only:[A-Z]{2}|unknown:(private|not_found|unavailable))$/.test(input["location"]) ? input["location"] : null;
  return { range, family, country, location, view: input["view"] === "globe" ? "globe" : "map" };
}
