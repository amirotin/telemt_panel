// Quota/activity bar arithmetic, shared by QuotaBar, the People row and the
// Инспектор's quota card so all three paint identical thresholds without
// importing a component module just for a class name.
//
// Two deliberate behavior choices live here (both changed in design pass
// D1 and kept on review):
//
// 1. The amber step starts at 80%, not at the 85% the pre-D1 QuotaBar used.
//    The prototype's bar switches at 80%, and on a phone the warning is
//    only useful if it arrives while there is still headroom to act on —
//    at 85% of a 50 GB quota that is 7.5 GB of notice, at 80% it is 10 GB.
// 2. A limit of 0 (or negative) counts as UNLIMITED, not as "instantly
//    exhausted". Telemt writes data_quota_bytes: 0 for a user with no cap,
//    and the pre-D1 `limit <= 0 ? 1 : …` guard already treated it that way
//    for the ratio; making it explicit stops a 0 limit from ever painting
//    the full red "quota exhausted" bar for someone who has no quota at all.

/** A null/undefined/0/negative limit all mean "no cap configured". */
export function isUnlimitedQuota(limitBytes: number | null | undefined): boolean {
  return limitBytes === null || limitBytes === undefined || limitBytes <= 0;
}

// quotaRatio is the 0..1 fill fraction. Unlimited reads as a full bar
// (there is no threshold to be under), and usage past the limit clamps at
// 1 rather than overflowing the track.
export function quotaRatio(usedBytes: number, limitBytes: number | null | undefined): number {
  if (isUnlimitedQuota(limitBytes)) return 1;
  return Math.max(0, Math.min(1, usedBytes / limitBytes!));
}

// quotaFillClass mirrors the prototype's three-step bar: accent under 80%,
// amber from 80%, the solid "exhausted" red at 100%.
export function quotaFillClass(ratio: number, unlimited: boolean): string {
  if (unlimited) return "bg-accent";
  if (ratio >= 1) return "bg-error-strong";
  if (ratio >= 0.8) return "bg-warn";
  return "bg-accent";
}
