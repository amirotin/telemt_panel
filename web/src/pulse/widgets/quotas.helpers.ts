import type { UsersTopic, UsersTopicUser } from "../../realtime/topics";
import { getUserQuota } from "../../people/users.helpers";
import { isUnlimitedQuota, quotaRatio } from "../../ui/quota.helpers";

/**
 * The quota fill from which a person is worth naming on Сводка. The same
 * 0.8 the bar itself turns amber at (ui/quota.helpers) — the card must not
 * have a second opinion about when a quota starts mattering.
 */
export const QUOTA_WATCH_THRESHOLD = 0.8;

/**
 * How far ahead an expiry is worth naming. Three days is the window an
 * admin can still act inside: long enough to notice on a weekly cadence,
 * short enough that the card is not a copy of the Люди list.
 */
export const EXPIRY_WATCH_MS = 3 * 24 * 60 * 60 * 1000;

/** Six rows: the card is half the grid and stands beside «События». */
export const QUOTA_WATCH_LIMIT = 6;

export interface QuotaWatchRow {
  username: string;
  /** 0…1 quota fill; null for a person with no cap configured. */
  quotaFill: number | null;
  /** Milliseconds until the access expires; negative once it has, null when it never does. */
  expiresInMs: number | null;
  /**
   * How loudly this row asks to be read, 0…1 — the worse of its two
   * reasons. Exposed because it IS the sort order, and a test that has to
   * infer the order from the rows would be testing its own arithmetic.
   */
  urgency: number;
}

function expiryAt(user: UsersTopicUser): number | null {
  if (!user.expiration_rfc3339) return null;
  const at = Date.parse(user.expiration_rfc3339);
  return Number.isNaN(at) ? null : at;
}

/**
 * computeQuotaWatch — «Квоты и сроки»: the people whose access is about to
 * stop working, for either of the two reasons access stops working.
 *
 * Only ENABLED people. A disabled access is already not working, and its
 * quota and its expiry are both moot: putting it here would spend a row on
 * something no deadline applies to.
 *
 * Urgency is the worse of the two reasons on one 0…1 scale, so a quota at
 * 99 % outranks an expiry three days out and an expiry tonight outranks a
 * quota at 81 % — without the card having to decide, in the abstract,
 * whether quotas matter more than dates.
 */
export function computeQuotaWatch(
  topic: Pick<UsersTopic, "users" | "quota"> | null | undefined,
  nowMs: number,
  limit: number = QUOTA_WATCH_LIMIT,
): QuotaWatchRow[] {
  if (!topic) return [];
  const rows: QuotaWatchRow[] = [];
  for (const user of topic.users) {
    if (!user.enabled) continue;

    const quota = getUserQuota(user, topic.quota?.[user.username]);
    const quotaFill = isUnlimitedQuota(quota.limitBytes)
      ? null
      : quotaRatio(quota.usedBytes, quota.limitBytes);
    const at = expiryAt(user);
    const expiresInMs = at === null ? null : at - nowMs;

    const quotaUrgency =
      quotaFill !== null && quotaFill >= QUOTA_WATCH_THRESHOLD ? quotaFill : null;
    const expiryUrgency =
      expiresInMs !== null && expiresInMs <= EXPIRY_WATCH_MS
        ? 1 - Math.max(expiresInMs, 0) / EXPIRY_WATCH_MS
        : null;
    if (quotaUrgency === null && expiryUrgency === null) continue;

    rows.push({
      username: user.username,
      quotaFill,
      // The date is only a FACT of the row when it is inside the window;
      // a person listed for their quota does not get "expires in 41 days"
      // printed beside it.
      expiresInMs: expiryUrgency === null ? null : expiresInMs,
      urgency: Math.max(quotaUrgency ?? 0, expiryUrgency ?? 0),
    });
  }
  return rows
    .sort((a, b) => b.urgency - a.urgency || a.username.localeCompare(b.username))
    .slice(0, Math.max(0, limit));
}
