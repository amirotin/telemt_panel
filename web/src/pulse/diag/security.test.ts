import { describe, expect, it } from "vitest";
import { securityGroups } from "./security.helpers";
import type { SecurityPosture, SecurityWhitelist } from "../../realtime/topics";
import { ru as s } from "../../i18n";

const posture: SecurityPosture = {
  api_read_only: false,
  api_whitelist_enabled: true,
  api_whitelist_entries: 1,
  api_auth_header_enabled: true,
  proxy_protocol_enabled: false,
  log_level: "info",
  telemetry_core_enabled: true,
  telemetry_user_enabled: false,
  telemetry_me_level: "basic",
};

const whitelist: SecurityWhitelist = { generated_at_epoch_secs: 0, enabled: true, entries_total: 1, entries: ["1.2.3.4/32"] };

describe("securityGroups", () => {
  it("returns no groups for an empty input", () => {
    expect(securityGroups({}, s)).toEqual([]);
  });

  it("includes only the provided sub-payloads' groups", () => {
    expect(securityGroups({ posture }, s).map((g) => g.title)).toEqual(["Посадка безопасности"]);
  });

  it("orders posture, whitelist, effective limits, then the four TLS scopes", () => {
    const groups = securityGroups({
      posture,
      whitelist,
      effectiveLimits: {
        update_every_secs: 5,
        me_reinit_every_secs: 60,
        me_pool_force_close_secs: 30,
        timeouts: { client_first_byte_idle_secs: 10, client_handshake_secs: 10, tg_connect_secs: 5, client_keepalive_secs: 30, client_ack_secs: 5, me_one_retry: 1, me_one_timeout_ms: 500 },
        upstream: { connect_retry_attempts: 3, connect_retry_backoff_ms: 100, connect_budget_ms: 5000, unhealthy_fail_threshold: 3, connect_failfast_hard_errors: true },
        middle_proxy: {},
        user_ip_policy: { global_each: 2, mode: "strict", window_secs: 3600 },
        user_tcp_policy: { global_each: 5 },
      },
      tlsFingerprints: {
        limit: 100,
        retention_secs: 3600,
        capacity: 1000,
        dropped_total: 0,
        parse_error_total: 0,
        by_fingerprint: [],
        by_ip: [],
        by_cidr: [],
        by_user: [],
      },
    }, s);
    expect(groups.map((g) => g.title)).toEqual([
      "Посадка безопасности",
      "Белый список",
      "Действующие лимиты",
      "По отпечатку",
      "По IP",
      "По подсети",
      "По пользователю",
    ]);
  });
});
