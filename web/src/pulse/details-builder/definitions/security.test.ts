// Checkpoint R5-Sec, the automatable half: §27.4 completeness for the
// Security / TLS page on the production-size fixtures (4×50 TLS records,
// posture, whitelist, 40 effective-limit leaves), plus the §23.3 shape.

import { describe, expect, it } from "vitest";
import { effectiveLimits, posture, tlsFingerprints, whitelist } from "../__fixtures__";
import { securityPageData } from "../../diag/security.helpers";
import { TLS_FINGERPRINTS_ENDPOINT } from "../fieldCatalog";
import { resolveSections } from "../resolveSections";
import type { CollectionSectionInstance, ScalarSectionInstance } from "../resolveSections";
import { securityPageDefinition, TLS_SCOPE_PATHS, type SecurityPageData } from "./security";

const topic = { posture, whitelist, effective_limits: effectiveLimits };

const full = securityPageData(topic, tlsFingerprints);
const topicOnly = securityPageData(topic, undefined);

function resolve(context: SecurityPageData | null) {
  if (context === null) throw new Error("adapter returned no payload");
  return resolveSections({
    definition: securityPageDefinition,
    context,
    endpoint: TLS_FINGERPRINTS_ENDPOINT,
  });
}

describe("securityPageData", () => {
  it("returns null when neither source has answered", () => {
    expect(securityPageData(null, undefined)).toBeNull();
  });

  it("spreads the TLS payload at the top level, the way the catalog is keyed", () => {
    expect(full?.by_fingerprint).toHaveLength(50);
    expect(full?.limit).toBe(50);
    expect(full?.posture).toBe(posture);
  });

  it("leaves the TLS half absent — not zeroed — when the capability is off", () => {
    expect(topicOnly?.by_fingerprint).toBeUndefined();
    expect(topicOnly?.limit).toBeUndefined();
    expect(topicOnly?.posture).toBe(posture);
  });
});

describe("Security page definition (spec §23.3)", () => {
  it("carries one ranking per scope, and the four never mix", () => {
    const result = resolve(full);
    for (const scope of TLS_SCOPE_PATHS) {
      const section = result.sections.find((s) => s.id === scope);
      expect(section?.kind, scope).toBe("ranking");
      expect((section as CollectionSectionInstance).items, scope).toHaveLength(50);
      expect((section as CollectionSectionInstance).path, scope).toBe(scope);
    }
  });

  it("gives each ranking its own tab, with posture first", () => {
    const tabs = securityPageDefinition.navigation?.tabs ?? [];
    expect(tabs.map((tab) => tab.id)).toEqual([
      "posture",
      "by_fingerprint",
      "by_ip",
      "by_cidr",
      "by_user",
    ]);
    // Every section belongs to exactly one tab: a section claimed by none
    // would silently vanish, one claimed twice would render twice.
    const claimed = tabs.flatMap((tab) => tab.sections ?? []);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(new Set(claimed)).toEqual(new Set(securityPageDefinition.sections.map((s) => s.id)));
  });

  it("sorts by total by default and offers bad_or_probe, as §23.3 asks", () => {
    for (const scope of TLS_SCOPE_PATHS) {
      const section = securityPageDefinition.sections.find((s) => s.id === scope);
      if (section?.kind !== "ranking") throw new Error(`${scope} is not a ranking`);
      expect(section.scoreKey, scope).toBe("total");
      expect(section.sort?.map((s) => s.key), scope).toContain("bad_or_probe");
    }
  });

  it("renders the whitelist addresses as a list, never a comma-joined row", () => {
    const result = resolve(full);
    const entries = result.sections.find((s) => s.id === "whitelist_entries");
    expect(entries?.kind).toBe("array");
    const scalarRows = result.sections
      .filter((section): section is ScalarSectionInstance => section.kind === "scalars")
      .flatMap((section) => section.rows.map((row) => row.path));
    expect(scalarRows).not.toContain("whitelist.entries");
  });

  it("keeps the middle_proxy knobs a forward-compatible map", () => {
    const result = resolve({
      ...full,
      effective_limits: {
        ...effectiveLimits,
        middle_proxy: { ...effectiveLimits.middle_proxy, a_knob_from_a_future_telemt: 7 },
      },
    });
    const map = result.sections.find((s) => s.id === "limits_middle_proxy");
    expect(map?.kind).toBe("dynamicMap");
    // A knob nobody has seen lands in the map, not in the unknown tail.
    expect(result.unknownPaths).toEqual([]);
    expect(map?.consumed).toContain("effective_limits.middle_proxy.a_knob_from_a_future_telemt");
  });

  it("reports «—» rather than a confident zero when the TLS source is off", () => {
    const summary = securityPageDefinition.summary ?? [];
    const observed = summary.find((m) => m.id === "observed");
    expect(observed?.value(full!)).toBe(
      tlsFingerprints.by_fingerprint.reduce((sum, row) => sum + row.total, 0),
    );
    expect(observed?.value(topicOnly!)).toBeNull();
  });
});

describe("checkpoint R5-Sec: completeness (§27.4, ruling R7)", () => {
  it("leaves an empty unknown tail on the full production payload", () => {
    const result = resolve(full);
    // 1955 TLS leaves + 9 posture + 4 whitelist (one of them the entries
    // array) + 40 effective-limit leaves.
    expect(result.allPaths.length).toBeGreaterThan(2000);
    expect(result.lostPaths).toEqual([]);
    expect(
      result.unknownPaths,
      `undescribed/unplaced Security paths:\n${result.unknownPaths.join("\n")}`,
    ).toEqual([]);
    expect(result.ignoredPaths).toEqual([]);
  });

  it("leaves an empty tail with the TLS capability switched off", () => {
    const result = resolve(topicOnly);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual([]);
  });

  it("leaves an empty tail with only the TLS half available", () => {
    const result = resolve(securityPageData(null, tlsFingerprints));
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual([]);
  });
});
