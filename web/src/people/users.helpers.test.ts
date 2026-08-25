import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_USER_SORT,
  bytesToQuotaDisplay,
  computeUserStatus,
  countUserFilters,
  filterUsersByQuery,
  formatBitsPerSecond,
  getStoredUserSort,
  getUserQuota,
  isOnline,
  isQuotaExhausted,
  isValidSecret,
  isValidUsername,
  matchesUserFilter,
  quotaUnitToBytes,
  sortPresetOf,
  SORT_PRESETS,
  setStoredUserSort,
  sortUsers,
  type UserQuotaView,
} from "./users.helpers";
import type { UsersTopicUser } from "../realtime/topics";

function user(overrides: Partial<UsersTopicUser> = {}): UsersTopicUser {
  return {
    username: "alice",
    enabled: true,
    in_runtime: true,
    current_connections: 0,
    active_unique_ips: 0,
    active_unique_ips_list: [],
    recent_unique_ips: 0,
    recent_unique_ips_list: [],
    total_octets: 0,
    links: { classic: [], secure: [], tls: [], tls_domains: [] },
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-25T12:00:00Z");

describe("getUserQuota", () => {
  it("prefers the quota-map entry when present", () => {
    const quota = getUserQuota(
      { data_quota_bytes: 999, total_octets: 5 },
      { data_quota_bytes: 100, used_bytes: 40, last_reset_epoch_secs: 0 },
    );
    expect(quota).toEqual({ usedBytes: 40, limitBytes: 100 });
  });

  it("falls back to data_quota_bytes/total_octets when there is no quota entry", () => {
    const quota = getUserQuota({ data_quota_bytes: 100, total_octets: 40 }, undefined);
    expect(quota).toEqual({ usedBytes: 40, limitBytes: 100 });
  });

  it("is unlimited when neither a quota entry nor a limit exists", () => {
    const quota = getUserQuota({ total_octets: 40 }, undefined);
    expect(quota).toEqual({ usedBytes: 40, limitBytes: null });
  });
});

describe("isQuotaExhausted", () => {
  it("is false when unlimited", () => {
    expect(isQuotaExhausted({ usedBytes: 1e12, limitBytes: null })).toBe(false);
  });
  it("is false strictly under the limit", () => {
    expect(isQuotaExhausted({ usedBytes: 99, limitBytes: 100 })).toBe(false);
  });
  it("is true exactly at the limit", () => {
    expect(isQuotaExhausted({ usedBytes: 100, limitBytes: 100 })).toBe(true);
  });
  it("is true over the limit", () => {
    expect(isQuotaExhausted({ usedBytes: 101, limitBytes: 100 })).toBe(true);
  });
});

describe("computeUserStatus", () => {
  const okQuota: UserQuotaView = { usedBytes: 0, limitBytes: null };

  it("is disabled when enabled=false, regardless of anything else", () => {
    const u = user({ enabled: false, expiration_rfc3339: "2020-01-01T00:00:00Z" });
    expect(computeUserStatus(u, okQuota, NOW)).toBe("disabled");
  });

  it("is expired when expiration is strictly in the past", () => {
    const u = user({ expiration_rfc3339: "2026-08-25T11:59:59Z" });
    expect(computeUserStatus(u, okQuota, NOW)).toBe("expired");
  });

  it("is expired exactly at the expiration instant (no grace period)", () => {
    const u = user({ expiration_rfc3339: "2026-08-25T12:00:00Z" });
    expect(computeUserStatus(u, okQuota, NOW)).toBe("expired");
  });

  it("is not expired one millisecond before the expiration instant", () => {
    const u = user({ expiration_rfc3339: "2026-08-25T12:00:00.001Z" });
    expect(computeUserStatus(u, okQuota, NOW)).toBe("active");
  });

  it("ignores an unparseable expiration string", () => {
    const u = user({ expiration_rfc3339: "not-a-date" });
    expect(computeUserStatus(u, okQuota, NOW)).toBe("active");
  });

  it("is quota_exhausted when over quota and not disabled/expired", () => {
    const u = user();
    expect(computeUserStatus(u, { usedBytes: 100, limitBytes: 100 }, NOW)).toBe(
      "quota_exhausted",
    );
  });

  it("is not_in_runtime when in_runtime=false and nothing else applies", () => {
    const u = user({ in_runtime: false });
    expect(computeUserStatus(u, okQuota, NOW)).toBe("not_in_runtime");
  });

  it("is active when nothing else applies", () => {
    const u = user();
    expect(computeUserStatus(u, okQuota, NOW)).toBe("active");
  });
});

describe("isOnline", () => {
  it("is true when current_connections > 0", () => {
    expect(isOnline({ current_connections: 1 })).toBe(true);
  });
  it("is false at zero", () => {
    expect(isOnline({ current_connections: 0 })).toBe(false);
  });
});

describe("quota unit conversion", () => {
  it("converts GB to bytes", () => {
    expect(quotaUnitToBytes(1, "GB")).toBe(1024 ** 3);
  });
  it("converts MB to bytes", () => {
    expect(quotaUnitToBytes(1, "MB")).toBe(1024 ** 2);
  });
  it("displays bytes at or above 1 GB in GB", () => {
    expect(bytesToQuotaDisplay(1024 ** 3 * 2.5)).toEqual({ value: 2.5, unit: "GB" });
  });
  it("displays bytes below 1 GB in MB", () => {
    expect(bytesToQuotaDisplay(1024 ** 2 * 512)).toEqual({ value: 512, unit: "MB" });
  });
  it("round-trips a whole-GB value", () => {
    const bytes = quotaUnitToBytes(10, "GB");
    expect(bytesToQuotaDisplay(bytes)).toEqual({ value: 10, unit: "GB" });
  });
});

describe("formatBitsPerSecond", () => {
  it("formats sub-1000 values as bit/s", () => {
    expect(formatBitsPerSecond(500)).toBe("500 бит/с");
  });
  it("formats thousands as Kbit/s", () => {
    expect(formatBitsPerSecond(1500)).toBe("1.5 Кбит/с");
  });
  it("formats millions as Mbit/s (keeps a decimal below 10 of a unit, matching formatBytes)", () => {
    expect(formatBitsPerSecond(2_000_000)).toBe("2.0 Мбит/с");
  });
});

describe("filterUsersByQuery", () => {
  const users = [user({ username: "alice" }), user({ username: "Bob" }), user({ username: "carol" })];

  it("returns everything for an empty/whitespace query", () => {
    expect(filterUsersByQuery(users, "  ")).toEqual(users);
  });

  it("matches case-insensitively by substring", () => {
    expect(filterUsersByQuery(users, "OB").map((u) => u.username)).toEqual(["Bob"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterUsersByQuery(users, "zzz")).toEqual([]);
  });
});

describe("sortUsers", () => {
  const users = [
    user({ username: "bob", total_octets: 200, current_connections: 1 }),
    user({ username: "alice", total_octets: 100, current_connections: 3 }),
    user({ username: "carol", total_octets: 300, current_connections: 2 }),
  ];

  it("sorts by name ascending", () => {
    expect(sortUsers(users, { field: "name", direction: "asc" }).map((u) => u.username)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("sorts by name descending", () => {
    expect(sortUsers(users, { field: "name", direction: "desc" }).map((u) => u.username)).toEqual([
      "carol",
      "bob",
      "alice",
    ]);
  });

  it("sorts by traffic ascending", () => {
    expect(
      sortUsers(users, { field: "traffic", direction: "asc" }).map((u) => u.username),
    ).toEqual(["alice", "bob", "carol"]);
  });

  it("sorts by connections descending", () => {
    expect(
      sortUsers(users, { field: "connections", direction: "desc" }).map((u) => u.username),
    ).toEqual(["alice", "carol", "bob"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...users];
    sortUsers(users, { field: "name", direction: "asc" });
    expect(users).toEqual(copy);
  });
});

describe("sort persistence", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to name/asc when nothing is stored", () => {
    expect(getStoredUserSort()).toEqual(DEFAULT_USER_SORT);
  });

  it("round-trips a stored value", () => {
    setStoredUserSort({ field: "traffic", direction: "desc" });
    expect(getStoredUserSort()).toEqual({ field: "traffic", direction: "desc" });
  });

  it("falls back to the default on garbage JSON", () => {
    localStorage.setItem("telemt-panel:people-sort:v1", "{not json");
    expect(getStoredUserSort()).toEqual(DEFAULT_USER_SORT);
  });

  it("falls back to the default on a well-formed but invalid value", () => {
    localStorage.setItem("telemt-panel:people-sort:v1", JSON.stringify({ field: "bogus" }));
    expect(getStoredUserSort()).toEqual(DEFAULT_USER_SORT);
  });

  it("falls back to the default when localStorage throws", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(getStoredUserSort()).toEqual(DEFAULT_USER_SORT);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe("validation", () => {
  it("accepts valid usernames", () => {
    expect(isValidUsername("alice")).toBe(true);
    expect(isValidUsername("A_liceZ.9-1")).toBe(true);
    expect(isValidUsername("a".repeat(64))).toBe(true);
  });
  it("rejects invalid usernames", () => {
    expect(isValidUsername("")).toBe(false);
    expect(isValidUsername("a".repeat(65))).toBe(false);
    expect(isValidUsername("has space")).toBe(false);
    expect(isValidUsername("has/slash")).toBe(false);
  });
  it("accepts a 32-hex secret, case-insensitively", () => {
    expect(isValidSecret("deadbeefdeadbeefdeadbeefdeadbeef")).toBe(true);
    expect(isValidSecret("DEADBEEFDEADBEEFDEADBEEFDEADBEEF")).toBe(true);
  });
  it("rejects a malformed secret", () => {
    expect(isValidSecret("deadbeef")).toBe(false);
    expect(isValidSecret("zzadbeefdeadbeefdeadbeefdeadbeef")).toBe(false);
  });
});

describe("filter segments", () => {
  const entries = [
    { user: user({ username: "online-ok", current_connections: 2 }), status: "active" as const },
    { user: user({ username: "idle-ok", current_connections: 0 }), status: "active" as const },
    { user: user({ username: "off", current_connections: 0 }), status: "disabled" as const },
    { user: user({ username: "burnt", current_connections: 3 }), status: "quota_exhausted" as const },
    { user: user({ username: "gone", current_connections: 0 }), status: "expired" as const },
    { user: user({ username: "unloaded", current_connections: 0 }), status: "not_in_runtime" as const },
  ];

  it("counts every segment off one pass", () => {
    expect(countUserFilters(entries)).toEqual({ all: 6, online: 2, issues: 4 });
  });

  it("counts an empty list as all-zero", () => {
    expect(countUserFilters([])).toEqual({ all: 0, online: 0, issues: 0 });
  });

  it("counts a user who is both online and in trouble in both segments", () => {
    const counts = countUserFilters([entries[3]!]);
    expect(counts).toEqual({ all: 1, online: 1, issues: 1 });
  });

  it("matches the same users the counts describe", () => {
    const kept = (filter: "all" | "online" | "issues") =>
      entries.filter((e) => matchesUserFilter(e, filter)).map((e) => e.user.username);
    expect(kept("all")).toHaveLength(6);
    expect(kept("online")).toEqual(["online-ok", "burnt"]);
    expect(kept("issues")).toEqual(["off", "burnt", "gone", "unloaded"]);
  });
});

describe("sort presets", () => {
  it("maps Активность to connections, descending", () => {
    expect(SORT_PRESETS.activity).toEqual({ field: "connections", direction: "desc" });
  });

  it("round-trips a preset back out of a stored sort state", () => {
    expect(sortPresetOf(SORT_PRESETS.activity)).toBe("activity");
    expect(sortPresetOf(SORT_PRESETS.name)).toBe("name");
    expect(sortPresetOf(SORT_PRESETS.traffic)).toBe("traffic");
  });

  it("returns null for a combination no chip offers", () => {
    expect(sortPresetOf({ field: "traffic", direction: "asc" })).toBeNull();
  });

  it("defaults to Активность", () => {
    expect(DEFAULT_USER_SORT).toEqual(SORT_PRESETS.activity);
  });

  it("orders the list by the preset it names", () => {
    const users = [
      user({ username: "a", current_connections: 1 }),
      user({ username: "b", current_connections: 9 }),
      user({ username: "c", current_connections: 4 }),
    ];
    expect(sortUsers(users, SORT_PRESETS.activity).map((u) => u.username)).toEqual(["b", "c", "a"]);
  });
});
