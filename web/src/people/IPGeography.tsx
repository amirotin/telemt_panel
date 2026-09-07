import type { GeoIpResult } from "../lib/api/generated/types.gen";
import { fill, useStrings } from "../i18n";

export function IPGeography({ geo }: { geo: GeoIpResult | null | undefined }) {
  const strings = useStrings();
  const s = strings.geoip;
  if (!geo || geo.state !== "found") return <div className="person-ip-geo" data-ip-geo>{geo?.state === "private" ? s.private : s.notFound}</div>;
  const country = (strings.locale === "ru" ? geo.country_name_ru : "") || geo.country_name || geo.country_code;
  const city = (strings.locale === "ru" ? geo.city_ru : "") || geo.city;
  return <div className="person-ip-geo" data-ip-geo>
    {country && <div className="person-ip-geo-place">{geo.country_code && <span className="person-ip-country-code" aria-hidden="true">{geo.country_code}</span>}<strong>{country}</strong></div>}
    {(geo.asn > 0 || geo.organization) && <small>{[geo.asn > 0 ? `AS${geo.asn}` : "", geo.organization].filter(Boolean).join(" · ")}</small>}
    {city && <small>{fill(s.approximate, { city })}</small>}
    {!country && !geo.asn && !geo.organization && !city && s.notFound}
  </div>;
}
