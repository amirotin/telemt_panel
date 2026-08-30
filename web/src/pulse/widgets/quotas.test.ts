import { describe, expect, it } from "vitest";
import {
  EXPIRY_WATCH_MS,
  QUOTA_WATCH_LIMIT,
  QUOTA_WATCH_THRESHOLD,
  computeQuotaWatch,
} from "./quotas.helpers";
import type { UsersTopic, UsersTopicUser } from "../../realtime/topics";

const NOW = Date.parse("2026-08-30T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function user(overrides: Partial<UsersTopicUser> & { username: string }): UsersTopicUser {
  return {
    enabled: true,
    in_runtime: true,
    current_connections: 0,
    active_unique_ips: 0,
    active_unique_ips_list: null,
    recent_unique_ips: 0,
    recent_unique_ips_list: null,
    total_octets: 0,
    links: { classic: [], secure: [], tls: [], tls_domains: [] },
    ...overrides,
  };
}

function topic(users: UsersTopicUser[], quota?: UsersTopic["quota"]): UsersTopic {
  return { users, quota: quota ?? null, quota_supported: quota !== undefined };
}

function inDays(days: number): string {
  return new Date(NOW + days * DAY).toISOString();
}

describe("computeQuotaWatch — who is about to stop working", () => {
  it("is empty before the first users frame, and on a healthy fleet", () => {
    expect(computeQuotaWatch(null, NOW)).toEqual([]);
    expect(
      computeQuotaWatch(
        topic([
          user({ username: "fine", total_octets: 10, data_quota_bytes: 1000 }),
          user({ username: "far", expiration_rfc3339: inDays(41) }),
          user({ username: "unlimited", total_octets: 9_000_000 }),
        ]),
        NOW,
      ),
    ).toEqual([]);
  });

  it("names a quota at or past the bar's own amber step, and nothing under it", () => {
    expect(QUOTA_WATCH_THRESHOLD).toBe(0.8);
    const rows = computeQuotaWatch(
      topic([
        user({ username: "at80", total_octets: 800, data_quota_bytes: 1000 }),
        user({ username: "under", total_octets: 799, data_quota_bytes: 1000 }),
      ]),
      NOW,
    );
    expect(rows.map((r) => r.username)).toEqual(["at80"]);
    expect(rows[0]!.quotaFill).toBe(0.8);
  });

  it("names an expiry inside the three-day window, and nothing past it", () => {
    expect(EXPIRY_WATCH_MS).toBe(3 * DAY);
    const rows = computeQuotaWatch(
      topic([
        user({ username: "soon", expiration_rfc3339: inDays(2) }),
        user({ username: "later", expiration_rfc3339: inDays(4) }),
      ]),
      NOW,
    );
    expect(rows.map((r) => r.username)).toEqual(["soon"]);
    expect(rows[0]!.expiresInMs).toBe(2 * DAY);
  });

  it("keeps an access whose date has already passed — it is the most urgent of all", () => {
    const rows = computeQuotaWatch(
      topic([user({ username: "past", expiration_rfc3339: inDays(-1) })]),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresInMs).toBeLessThan(0);
    expect(rows[0]!.urgency).toBe(1);
  });

  it("skips a disabled access — no deadline applies to one that is already off", () => {
    expect(
      computeQuotaWatch(
        topic([
          user({
            username: "off",
            enabled: false,
            total_octets: 999,
            data_quota_bytes: 1000,
            expiration_rfc3339: inDays(1),
          }),
        ]),
        NOW,
      ),
    ).toEqual([]);
  });

  it("prefers Telemt's tracked usage over the cumulative-traffic fallback", () => {
    const rows = computeQuotaWatch(
      topic([user({ username: "tracked", total_octets: 10, data_quota_bytes: 1000 })], {
        tracked: { data_quota_bytes: 1000, used_bytes: 870, last_reset_epoch_secs: 0 },
      }),
      NOW,
    );
    expect(rows.map((r) => r.username)).toEqual(["tracked"]);
    expect(rows[0]!.quotaFill).toBeCloseTo(0.87);
  });

  it("sorts by the worse of the two reasons, on one scale", () => {
    const rows = computeQuotaWatch(
      topic([
        user({ username: "quota81", total_octets: 810, data_quota_bytes: 1000 }),
        user({ username: "quota99", total_octets: 990, data_quota_bytes: 1000 }),
        user({ username: "expires_today", expiration_rfc3339: inDays(0.2) }),
        user({ username: "expires_in3", expiration_rfc3339: inDays(2.9) }),
      ]),
      NOW,
    );
    // 0.99 full beats an access with a fifth of a day left (0.93 of the
    // window spent), which beats 0.81 full, which beats a date three days
    // out (0.03). One scale, no ruling on whether quotas outrank dates.
    expect(rows.map((r) => r.username)).toEqual([
      "quota99",
      "expires_today",
      "quota81",
      "expires_in3",
    ]);
  });

  it("carries both facts for a person who is in for both reasons", () => {
    const [row] = computeQuotaWatch(
      topic([
        user({
          username: "both",
          total_octets: 900,
          data_quota_bytes: 1000,
          expiration_rfc3339: inDays(1),
        }),
      ]),
      NOW,
    );
    expect(row!.quotaFill).toBe(0.9);
    expect(row!.expiresInMs).toBe(DAY);
  });

  it("does not print a far-off date beside a quota row", () => {
    const [row] = computeQuotaWatch(
      topic([
        user({
          username: "quota_only",
          total_octets: 900,
          data_quota_bytes: 1000,
          expiration_rfc3339: inDays(41),
        }),
      ]),
      NOW,
    );
    expect(row!.expiresInMs).toBeNull();
  });

  it("stops at six rows while still ranking every candidate", () => {
    expect(QUOTA_WATCH_LIMIT).toBe(6);
    const many = Array.from({ length: 12 }, (_, i) =>
      user({
        username: `u${String(i).padStart(2, "0")}`,
        total_octets: 800 + i * 10,
        data_quota_bytes: 1000,
      }),
    );
    const rows = computeQuotaWatch(topic(many), NOW);
    expect(rows).toHaveLength(QUOTA_WATCH_LIMIT);
    // The fullest six, not the first six the payload happened to list.
    expect(rows.map((r) => r.username)).toEqual(["u11", "u10", "u09", "u08", "u07", "u06"]);
  });

  it("ignores an unparseable expiry rather than treating it as overdue", () => {
    expect(
      computeQuotaWatch(topic([user({ username: "junk", expiration_rfc3339: "soon" })]), NOW),
    ).toEqual([]);
  });
});
