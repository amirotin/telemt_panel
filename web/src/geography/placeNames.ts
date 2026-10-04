import type { GeographyCountry, GeographyLocation } from "../lib/api/generated/types.gen";
import type { Dict } from "../i18n";

export function placeName(
  place: GeographyCountry | GeographyLocation,
  locale: string,
  words: Dict["geography"],
): string {
  if (place.id === "unknown:private") return words.private;
  if (place.id === "unknown:not_found") return words.notFound;
  if (place.id === "unknown:unavailable") return words.geoUnavailable;
  if (place.id.startsWith("country-only:")) return `${words.countryOnly} · ${place.country_code}`;
  return (
    (locale === "ru" ? place.name_ru || place.name : place.name) ||
    place.country_code ||
    words.networkLocation
  );
}
