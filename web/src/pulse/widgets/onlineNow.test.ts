import { describe, expect, it } from "vitest";
import type { UsersTopicUser } from "../../realtime/topics";
import { ONLINE_NOW_LIMIT, ONLINE_NOW_LIMIT_PHONE, computeOnlineNow } from "./onlineNow.helpers";

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

describe("computeOnlineNow", () => {
  const users = [
    user({ username: "idle" }),
    user({ username: "marat", current_connections: 3, active_unique_ips: 2, total_octets: 900 }),
    user({ username: "lena", current_connections: 1, total_octets: 500 }),
    user({ username: "olga", current_connections: 1, total_octets: 700 }),
    user({ username: "disabled_but_connected", enabled: false, current_connections: 2 }),
  ];

  it("counts only people with a live connection, against every configured access", () => {
    const view = computeOnlineNow(users);
    expect(view.online).toBe(4);
    expect(view.total).toBe(5);
  });

  it("orders by connections, then traffic, then name", () => {
    expect(computeOnlineNow(users).rows.map((r) => r.username)).toEqual([
      "marat",
      "disabled_but_connected",
      "olga",
      "lena",
    ]);
  });

  it("breaks a full tie by username so a realtime frame cannot reshuffle the rows", () => {
    const tied = [
      user({ username: "zoe", current_connections: 1 }),
      user({ username: "adam", current_connections: 1 }),
    ];
    expect(computeOnlineNow(tied).rows.map((r) => r.username)).toEqual(["adam", "zoe"]);
    expect(computeOnlineNow([...tied].reverse()).rows.map((r) => r.username)).toEqual([
      "adam",
      "zoe",
    ]);
  });

  it("keeps at most `limit` rows while still counting everyone", () => {
    const view = computeOnlineNow(users, 2);
    expect(view.rows).toHaveLength(2);
    expect(view.online).toBe(4);
  });

  it("carries the figures the row prints", () => {
    const [row] = computeOnlineNow(users).rows;
    expect(row).toEqual({
      username: "marat",
      connections: 3,
      ips: 2,
      totalOctets: 900,
      quotaFill: null,
    });
  });

  // The bar at the row's right edge: the same getUserQuota/quotaRatio pair
  // the Люди list paints with, so one name cannot read two fills.
  describe("the quota bar the row ends in", () => {
    it("is null for a person with no cap — there is nothing to fill", () => {
      expect(computeOnlineNow(users).rows.every((r) => r.quotaFill === null)).toBe(true);
    });

    it("prefers Telemt's tracked usage when the quota capability is on", () => {
      const capped = [user({ username: "marat", current_connections: 1, total_octets: 900 })];
      const rows = computeOnlineNow(capped, ONLINE_NOW_LIMIT, {
        marat: { data_quota_bytes: 1000, used_bytes: 870, last_reset_epoch_secs: 0 },
      }).rows;
      expect(rows[0]!.quotaFill).toBeCloseTo(0.87);
    });

    it("falls back to the user's own limit against cumulative traffic", () => {
      const capped = [
        user({
          username: "lena",
          current_connections: 1,
          total_octets: 500,
          data_quota_bytes: 1000,
        }),
      ];
      expect(computeOnlineNow(capped).rows[0]!.quotaFill).toBe(0.5);
    });

    it("clamps a person past their cap instead of overflowing the track", () => {
      const capped = [
        user({
          username: "over",
          current_connections: 1,
          total_octets: 4000,
          data_quota_bytes: 1000,
        }),
      ];
      expect(computeOnlineNow(capped).rows[0]!.quotaFill).toBe(1);
    });
  });

  it("is empty — not a crash — before the first users frame", () => {
    expect(computeOnlineNow(null)).toEqual({ online: 0, total: 0, rows: [] });
    expect(computeOnlineNow([])).toEqual({ online: 0, total: 0, rows: [] });
  });
});

describe("how many names the card lists", () => {
  const busy = (name: string, connections: number) =>
    user({ username: name, current_connections: connections });

  it("returns the desktop count by default, and the phone cut is a subset of it", () => {
    const users = Array.from({ length: 20 }, (_, i) =>
      busy(`u${String(i).padStart(2, "0")}`, 20 - i),
    );
    const rows = computeOnlineNow(users).rows;
    expect(rows.length).toBe(ONLINE_NOW_LIMIT);
    expect(ONLINE_NOW_LIMIT_PHONE).toBeLessThan(ONLINE_NOW_LIMIT);
    // The phone shows the first five of the same ordered list — one list,
    // cut by CSS, so the two viewports can never disagree about who is busiest.
    expect(rows.slice(0, ONLINE_NOW_LIMIT_PHONE).map((r) => r.username)).toEqual(
      computeOnlineNow(users, ONLINE_NOW_LIMIT_PHONE).rows.map((r) => r.username),
    );
  });

  it("lists only what exists — the card never pads itself to the limit", () => {
    expect(computeOnlineNow([busy("a", 3), busy("b", 1)]).rows.length).toBe(2);
  });
});
