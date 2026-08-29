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
    expect(row).toEqual({ username: "marat", connections: 3, ips: 2, totalOctets: 900 });
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
