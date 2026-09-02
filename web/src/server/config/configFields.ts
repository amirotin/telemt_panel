// The Quick Settings form's known-field catalog for the editable config
// sections this page scopes itself to (general/timeouts/censorship, plus
// `web` since Telemt 3.5.3 — server/network/upstreams/dc_overrides are left
// to the raw editor). Field names/kinds come from the v1 panel's own QuickSettingsTab
// (v0/frontend/src/components/config/QuickSettingsTab.tsx), the closest
// concrete source of Telemt's actual config keys available in this repo —
// 07-telemt-sdk.md documents the editable *sections*, not their individual
// field names. Any key present in a section's JSON that isn't listed here
// is rendered read-only (06-ui.md: "completeness" — an unrecognized key
// must still be visible, never silently dropped).
export type ConfigFieldKind = "bool" | "string" | "int";

export type ConfigSectionName = "general" | "timeouts" | "censorship" | "web";

export interface ConfigFieldDef {
  section: ConfigSectionName;
  key: string;
  kind: ConfigFieldKind;
}

export const CONFIG_FIELDS: ConfigFieldDef[] = [
  { section: "general", key: "use_middle_proxy", kind: "bool" },
  { section: "general", key: "ad_tag", kind: "string" },
  { section: "general", key: "middle_proxy_nat_ip", kind: "string" },
  { section: "general", key: "middle_proxy_nat_probe", kind: "bool" },
  { section: "general", key: "tg_connect", kind: "int" },
  { section: "censorship", key: "tls_domain", kind: "string" },
  { section: "censorship", key: "mask", kind: "bool" },
  { section: "censorship", key: "mask_host", kind: "string" },
  { section: "censorship", key: "tls_emulation", kind: "bool" },
  { section: "timeouts", key: "client_handshake", kind: "int" },
  { section: "timeouts", key: "client_ack", kind: "int" },
  // WEB mode (Telemt >= 3.5.3). ONE key by design: `enabled` is the switch
  // an operator flips, and the rest of `[web]` — vhosts, profiles, carriers,
  // 47 limits, 22 timeouts — is structure a form cannot express honestly.
  // It stays in the raw editor, where it round-trips whole.
  { section: "web", key: "enabled", kind: "bool" },
];

export const QUICK_SETTINGS_SECTIONS = ["general", "timeouts", "censorship", "web"] as const;

/**
 * Sections rendered only when Telemt actually sends them.
 *
 * `web` became an editable section in Telemt 3.5.3. On an older build GET
 * /v1/config simply omits it, and offering a toggle there would build a
 * PATCH the proxy rejects — a control that cannot work is worse than no
 * control (06-ui.md). The other three have been editable for as long as the
 * config API has existed, so they keep rendering unconditionally rather than
 * disappearing from a config file that happens to omit one.
 */
export const SECTIONS_REQUIRING_PRESENCE = new Set<string>(["web"]);

// isQuickSettingsSectionShown decides whether a section gets a card.
export function isQuickSettingsSectionShown(
  section: string,
  sections: Record<string, unknown>,
): boolean {
  if (!SECTIONS_REQUIRING_PRESENCE.has(section)) return true;
  return sections[section] !== undefined && sections[section] !== null;
}

// unknownKeysInSection lists a section's keys that aren't in the known-field
// catalog above — rendered read-only in the Quick Settings form so nothing
// in these three sections is ever silently hidden.
export function unknownKeysInSection(section: string, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const known = new Set(CONFIG_FIELDS.filter((f) => f.section === section).map((f) => f.key));
  return Object.keys(value as Record<string, unknown>).filter((k) => !known.has(k));
}
