import type { GeoIpConfig } from "../../lib/api/generated/types.gen";

export const geoIPKinds = ["country", "asn", "city"] as const;

export function defaultGeoIPConfig(): GeoIpConfig {
  return {
    enabled: false, source: "community", schedule: "weekly",
    country: { enabled: true, location: "" },
    asn: { enabled: true, location: "" },
    city: { enabled: false, location: "" },
  };
}

export function switchGeoIPSource(config: GeoIpConfig, source: GeoIpConfig["source"]): GeoIpConfig {
  if (source === config.source) return config;
  return { ...config, source, country: { ...config.country, location: "" }, asn: { ...config.asn, location: "" }, city: { ...config.city, location: "" } };
}

export function normalizeGeoIPConfig(config: GeoIpConfig): GeoIpConfig {
  return {
    ...config,
    country: { ...config.country, location: config.country.location.trim() },
    asn: { ...config.asn, location: config.asn.location.trim() },
    city: { ...config.city, location: config.city.location.trim() },
  };
}

export function sameGeoIPConfig(a: GeoIpConfig, b: GeoIpConfig): boolean {
  return a.enabled === b.enabled && a.source === b.source && a.schedule === b.schedule
    && geoIPKinds.every(kind => a[kind].enabled === b[kind].enabled && a[kind].location === b[kind].location);
}

export function geoIPConfigError(config: GeoIpConfig): "dataset" | "url" | "path" | null {
  if (!config.enabled) return null;
  const selected = geoIPKinds.filter(kind => config[kind].enabled);
  if (!selected.length) return "dataset";
  for (const kind of selected) {
    const location = config[kind].location.trim();
    if (config.source === "files" && (!location.startsWith("/") || location.includes("\0"))) return "path";
    if (config.source === "urls") {
      try {
        const url = new URL(location);
        if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) return "url";
      } catch { return "url"; }
    }
  }
  return null;
}
