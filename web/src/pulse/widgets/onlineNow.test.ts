import { describe, expect, it } from "vitest";
import type { UsersTopicQuotaEntry, UsersTopicUser } from "../../realtime/topics";
import { CLIENT_ATTENTION_LIMIT, computeClientAttention } from "./onlineNow.helpers";

const NOW = Date.parse("2026-08-30T12:00:00Z");

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

function quota(used: number, limit: number): UsersTopicQuotaEntry {
  return { used_bytes: used, data_quota_bytes: limit, last_reset_epoch_secs: 0 };
}

describe("computeClientAttention", () => {
  it("returns only actionable client deviations", () => {
    const view = computeClientAttention(
      [
        user({ username: "healthy", current_connections: 3, max_tcp_conns: 10 }),
        user({ username: "near", current_connections: 8, max_tcp_conns: 10 }),
        user({ username: "runtime", in_runtime: false }),
      ],
      null,
      NOW,
    );
    expect(view.rows.map((row) => row.username)).toEqual(["near", "runtime"]);
    expect(view.attentionCount).toBe(2);
  });

  it("promotes exhausted and expired clients above warnings", () => {
    const view = computeClientAttention(
      [
        user({ username: "near", max_unique_ips: 10, recent_unique_ips: 8 }),
        user({ username: "expired", expiration_rfc3339: "2026-08-29T12:00:00Z" }),
        user({ username: "quota" }),
      ],
      { quota: quota(110, 100) },
      NOW,
    );
    expect(view.rows.map((row) => row.username)).toEqual(["quota", "expired", "near"]);
    expect(view.rows[0].severity).toBe("error");
  });

  it("groups several signals under one client", () => {
    const view = computeClientAttention(
      [
        user({
          username: "multi",
          current_connections: 10,
          max_tcp_conns: 10,
          max_unique_ips: 5,
          recent_unique_ips: 5,
          in_runtime: false,
        }),
      ],
      { multi: quota(90, 100) },
      NOW,
    );
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].signals.map((signal) => signal.kind)).toEqual([
      "connections",
      "ips",
      "quota",
      "runtime",
    ]);
  });

  it("uses the larger active/recent IP count", () => {
    const view = computeClientAttention(
      [user({ username: "ip", max_unique_ips: 10, active_unique_ips: 2, recent_unique_ips: 9 })],
      null,
      NOW,
    );
    expect(view.rows[0].signals[0]).toMatchObject({ kind: "ips", current: 9, ratio: 90 });
  });

  it("warns seven days before expiry and ignores disabled expiry", () => {
    const view = computeClientAttention(
      [
        user({ username: "soon", expiration_rfc3339: "2026-09-05T12:00:00Z" }),
        user({ username: "later", expiration_rfc3339: "2026-09-10T12:00:00Z" }),
        user({ username: "disabled", enabled: false, expiration_rfc3339: "2026-08-29T12:00:00Z" }),
      ],
      null,
      NOW,
    );
    expect(view.rows.map((row) => row.username)).toEqual(["soon"]);
  });

  it("keeps concentration as secondary context, not an alert", () => {
    const view = computeClientAttention(
      [
        user({ username: "busy", current_connections: 6 }),
        user({ username: "other", current_connections: 4 }),
      ],
      null,
      NOW,
    );
    expect(view.rows).toEqual([]);
    expect(view.topConcentration).toEqual({ username: "busy", connections: 6, sharePct: 60 });
  });

  it("limits displayed rows but keeps the full attention count", () => {
    const users = Array.from({ length: CLIENT_ATTENTION_LIMIT + 2 }, (_, index) =>
      user({ username: `u${index}`, in_runtime: false }),
    );
    const view = computeClientAttention(users, null, NOW);
    expect(view.rows).toHaveLength(CLIENT_ATTENTION_LIMIT);
    expect(view.attentionCount).toBe(CLIENT_ATTENTION_LIMIT + 2);
  });

  it("is empty before the first users frame", () => {
    expect(computeClientAttention(null, null, NOW)).toEqual({
      rows: [],
      attentionCount: 0,
      topConcentration: null,
    });
  });
});
