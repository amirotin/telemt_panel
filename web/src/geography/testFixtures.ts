import type { GeographyLocation, GeographyOverview } from "../lib/api/generated/types.gen";

export function location(id: string, count = 1): GeographyLocation {
  return {
    id,
    country_code: "DE",
    name: "City",
    name_ru: "Fixture city",
    city_id: 1,
    location: { latitude: 0, longitude: 0, accuracy_radius_km: null },
    unique_ips: count,
    accounts: 1,
  };
}

export function overview(patch: Partial<GeographyOverview> = {}): GeographyOverview {
  return {
    snapshot_id: "00000000000000000000000000000001",
    generated_at: 1800000000,
    expires_at: 1800000120,
    as_of: 1800000000,
    served_at: 1800000000,
    range: "now",
    family: "all",
    state: "ready",
    totals: { unique_ips: 1, accounts: 1, country_count: 1, location_count: 1 },
    quality: {
      located: 1,
      country_only: 0,
      private: 0,
      not_found: 0,
      unavailable: 0,
      coordinate_coverage: 1,
      geo_conflicts: 0,
    },
    source: {
      kind: "live",
      observed_at: 1800000000,
      age_secs: 0,
      requested_from: null,
      effective_from: null,
      retention_days: null,
      durable: null,
      partial: false,
      input_truncated: false,
      collection_gap: false,
      pending: false,
      invalid_users: 0,
    },
    geoip: {
      state: "ready",
      available: true,
      active_source: "files",
      databases: [],
      last_error: null,
    },
    countries: [
      {
        id: "country:DE",
        country_code: "DE",
        name: "Germany",
        name_ru: "Fixture Germany",
        unique_ips: 1,
        accounts: 1,
      },
    ],
    points: [location("city:DE:1")],
    visible: {
      points: 1,
      total_coordinate_locations: 1,
      omitted_points: 0,
      countries: 1,
      total_countries: 1,
      omitted_countries: 0,
    },
    selection: null,
    server: { state: "hidden", origin: null, label: "", location: null },
    ...patch,
  };
}
