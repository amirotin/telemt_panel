// The Quick Settings form's known-field catalog for the three editable
// config sections the task brief scopes this page to (general/timeouts/
// censorship — server/network/upstreams/dc_overrides are left to the raw
// editor). Field names/kinds come from the v1 panel's own QuickSettingsTab
// (v0/frontend/src/components/config/QuickSettingsTab.tsx), the closest
// concrete source of Telemt's actual config keys available in this repo —
// 07-telemt-sdk.md documents the editable *sections*, not their individual
// field names. Any key present in a section's JSON that isn't listed here
// is rendered read-only (06-ui.md: "completeness" — an unrecognized key
// must still be visible, never silently dropped).
export type ConfigFieldKind = "bool" | "string" | "int";

export interface ConfigFieldDef {
  section: "general" | "timeouts" | "censorship";
  key: string;
  kind: ConfigFieldKind;
}

export const CONFIG_FIELDS: ConfigFieldDef[] = [
  { section: "general", key: "use_middle_proxy", kind: "bool" },
  { section: "general", key: "ad_tag", kind: "string" },
  { section: "general", key: "middle_proxy_nat_ip", kind: "string" },
  { section: "general", key: "middle_proxy_nat_probe", kind: "bool" },
  { section: "censorship", key: "tls_domain", kind: "string" },
  { section: "censorship", key: "mask", kind: "bool" },
  { section: "censorship", key: "mask_host", kind: "string" },
  { section: "censorship", key: "tls_emulation", kind: "bool" },
  { section: "timeouts", key: "client_handshake", kind: "int" },
  { section: "timeouts", key: "tg_connect", kind: "int" },
  { section: "timeouts", key: "client_ack", kind: "int" },
];

export const QUICK_SETTINGS_SECTIONS = ["general", "timeouts", "censorship"] as const;

// unknownKeysInSection lists a section's keys that aren't in the known-field
// catalog above — rendered read-only in the Quick Settings form so nothing
// in these three sections is ever silently hidden.
export function unknownKeysInSection(section: string, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const known = new Set(CONFIG_FIELDS.filter((f) => f.section === section).map((f) => f.key));
  return Object.keys(value as Record<string, unknown>).filter((k) => !known.has(k));
}
