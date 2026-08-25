import { ru } from "../../i18n/ru";
import { flattenToRows, type KVGroup } from "./rows";
import type {
  EffectiveLimits,
  RuntimeEdgeTLSFingerprints,
  SecurityPosture,
  SecurityWhitelist,
} from "../../realtime/topics";

export interface SecurityGroupsInput {
  posture?: SecurityPosture;
  whitelist?: SecurityWhitelist;
  effectiveLimits?: EffectiveLimits;
  tlsFingerprints?: RuntimeEdgeTLSFingerprints;
}

// securityGroups: posture/whitelist/effective_limits are always-on (never
// Gated[T]) so they contribute unconditionally once loaded; tls_fingerprints
// is runtime-edge-gated and extended-mode-only, split into its four scopes
// (by_fingerprint/by_ip/by_cidr/by_user) — full breakdown, unlike the
// widget's single top-N-by-fingerprint table.
export function securityGroups(input: SecurityGroupsInput): KVGroup[] {
  const groups: KVGroup[] = [];
  if (input.posture) groups.push({ title: ru.diag.groups.posture, rows: flattenToRows(input.posture) });
  if (input.whitelist) groups.push({ title: ru.diag.groups.whitelist, rows: flattenToRows(input.whitelist) });
  if (input.effectiveLimits) {
    groups.push({ title: ru.diag.groups.effectiveLimits, rows: flattenToRows(input.effectiveLimits) });
  }
  if (input.tlsFingerprints) {
    groups.push({ title: ru.diag.groups.tlsByFingerprint, rows: flattenToRows(input.tlsFingerprints.by_fingerprint) });
    groups.push({ title: ru.diag.groups.tlsByIp, rows: flattenToRows(input.tlsFingerprints.by_ip) });
    groups.push({ title: ru.diag.groups.tlsByCidr, rows: flattenToRows(input.tlsFingerprints.by_cidr) });
    groups.push({ title: ru.diag.groups.tlsByUser, rows: flattenToRows(input.tlsFingerprints.by_user) });
  }
  return groups;
}
