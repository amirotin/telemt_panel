import type { Dict } from "../../i18n";
import { flattenToRows, type KVGroup } from "./rows";
import type {
  EffectiveLimits,
  SecurityPosture,
  SecurityTopic,
  SecurityWhitelist,
} from "../../realtime/topics";
import type { SecurityPageData } from "../details-builder/definitions/security";
// TLS fingerprints are a REST payload (GET /api/telemt/tls-fingerprints),
// not a topic field, since M4 task 1 — hence the generated client's type.
import type { TlsFingerprints } from "../../lib/api/generated/types.gen";

export interface SecurityGroupsInput {
  posture?: SecurityPosture;
  whitelist?: SecurityWhitelist;
  effectiveLimits?: EffectiveLimits;
  tlsFingerprints?: TlsFingerprints;
}

// securityGroups: posture/whitelist/effective_limits are always-on (never
// Gated[T]) so they contribute unconditionally once loaded; tlsFingerprints
// is runtime-edge-gated and extended-mode-only, split into its four scopes
// (by_fingerprint/by_ip/by_cidr/by_user) — full breakdown, unlike the
// widget's single top-N-by-fingerprint table.
export function securityGroups(input: SecurityGroupsInput, s: Dict): KVGroup[] {
  const groups: KVGroup[] = [];
  if (input.posture) groups.push({ title: s.diag.groups.posture, rows: flattenToRows(input.posture, s) });
  if (input.whitelist) groups.push({ title: s.diag.groups.whitelist, rows: flattenToRows(input.whitelist, s) });
  if (input.effectiveLimits) {
    groups.push({ title: s.diag.groups.effectiveLimits, rows: flattenToRows(input.effectiveLimits, s) });
  }
  if (input.tlsFingerprints) {
    groups.push({ title: s.diag.groups.tlsByFingerprint, rows: flattenToRows(input.tlsFingerprints.by_fingerprint, s) });
    groups.push({ title: s.diag.groups.tlsByIp, rows: flattenToRows(input.tlsFingerprints.by_ip, s) });
    groups.push({ title: s.diag.groups.tlsByCidr, rows: flattenToRows(input.tlsFingerprints.by_cidr, s) });
    groups.push({ title: s.diag.groups.tlsByUser, rows: flattenToRows(input.tlsFingerprints.by_user, s) });
  }
  return groups;
}

// securityPageData joins the `security` topic with the separately fetched
// TLS aggregates into the ONE payload the Security Details page's
// definition reads (details-builder/definitions/security.ts).
//
// The TLS half is SPREAD at the top level rather than nested: the field
// catalog's TLS entries are endpoint-scoped (ruling R9) and keyed exactly
// the way the REST payload spells them (`by_fingerprint.*.ja4`, `limit`,
// `capacity`), so a `tls.` prefix here would orphan every one of those
// descriptions. Absent halves stay absent — §13.1 keeps "no source" and
// "no observations" apart, and the page's per-source states say which.
export function securityPageData(
  topic: SecurityTopic | null | undefined,
  tls: TlsFingerprints | undefined,
): SecurityPageData | null {
  if (!topic && !tls) return null;
  return {
    ...(topic?.posture ? { posture: topic.posture } : {}),
    ...(topic?.whitelist ? { whitelist: topic.whitelist } : {}),
    ...(topic?.effective_limits ? { effective_limits: topic.effective_limits } : {}),
    ...(tls ?? {}),
  };
}
