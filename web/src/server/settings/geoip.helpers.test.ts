import { describe, expect, it } from "vitest";
import { defaultGeoIPConfig, geoIPConfigError, normalizeGeoIPConfig, sameGeoIPConfig, switchGeoIPSource } from "./geoip.helpers";

describe("GeoIP draft validation", () => {
  it("defaults to an inactive community source without city", () => {
    const config = defaultGeoIPConfig();
    expect(config.enabled).toBe(false);
    expect(config.source).toBe("community");
    expect(config.country.enabled && config.asn.enabled).toBe(true);
    expect(config.city.enabled).toBe(false);
    expect(geoIPConfigError({ ...config, enabled: true })).toBeNull();
  });
  it("requires a dataset only when enabling", () => {
    const config = defaultGeoIPConfig();
    for (const kind of ["country", "asn", "city"] as const) config[kind].enabled = false;
    expect(geoIPConfigError(config)).toBeNull();
    expect(geoIPConfigError({ ...config, enabled: true })).toBe("dataset");
  });
  it.each(["http://example.org/db.mmdb", "https://name:secret@example.org/db.mmdb", "https://example.org/db.mmdb#fragment", "not a URL"])("rejects unsafe URL %s", location => {
    const config = { ...defaultGeoIPConfig(), enabled: true, source: "urls" as const };
    config.country.location = location;
    config.asn.enabled = false;
    expect(geoIPConfigError(config)).toBe("url");
  });
  it("checks only selected dataset paths", () => {
    const config = { ...defaultGeoIPConfig(), enabled: true, source: "files" as const };
    config.country.location = "/srv/geo/country.mmdb";
    config.asn.enabled = false;
    expect(geoIPConfigError(config)).toBeNull();
    config.country.location = "relative.mmdb";
    expect(geoIPConfigError(config)).toBe("path");
  });
  it.each([
    ["urls", "  https://example.org/my db.mmdb  "],
    ["files", "  /srv/geo/my db.mmdb  "],
  ] as const)("normalizes %s locations without changing internal spaces or the original config", (source, location) => {
    const config = { ...defaultGeoIPConfig(), enabled: true, source };
    config.country.location = location;
    config.asn.enabled = false;
    const normalized = normalizeGeoIPConfig(config);

    expect(normalized.country.location).toBe(location.trim());
    expect(normalized.country.location).toContain("my db.mmdb");
    expect(normalized).not.toBe(config);
    expect(normalized.country).not.toBe(config.country);
    expect(config.country.location).toBe(location);
  });
  it("switches source without reusing a URL as a filesystem path or mutating saved config", () => {
    const saved = defaultGeoIPConfig();
    saved.country.location = "https://example.org/db.mmdb";
    const draft = switchGeoIPSource(saved, "files");
    expect(draft.country.location).toBe("");
    expect(saved.country.location).toContain("https://");
    expect(sameGeoIPConfig(saved, draft)).toBe(false);
    expect(sameGeoIPConfig(saved, structuredClone(saved))).toBe(true);
  });
});
