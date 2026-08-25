import type { SecurityPosture } from "../../realtime/topics";
import type { State } from "../../ui/StatePill";
import { ru } from "../../i18n/ru";

export interface PostureBadge {
  key: string;
  label: string;
  state: State;
  text: string;
}

// postureBadges turns SecurityPosture's fields into StatePill rows
// (06-ui.md §Сервер: posture = "KVRow+StatePill"). Only the two flags an
// admin actually wants ON for a hardened setup (whitelist enabled, an auth
// header configured) get an ok/warn semantic split; api_read_only and
// proxy_protocol/telemetry flags are informational either way — "on" isn't
// inherently safer or worse — so they render as a neutral `muted` pill.
export function postureBadges(posture: SecurityPosture): PostureBadge[] {
  const yn = (v: boolean) => (v ? ru.common.yes : ru.common.no);
  return [
    {
      key: "api_whitelist_enabled",
      label: ru.server.security.postureFields.apiWhitelistEnabled,
      state: posture.api_whitelist_enabled ? "ok" : "warn",
      text: yn(posture.api_whitelist_enabled),
    },
    {
      key: "api_auth_header_enabled",
      label: ru.server.security.postureFields.apiAuthHeaderEnabled,
      state: posture.api_auth_header_enabled ? "ok" : "warn",
      text: yn(posture.api_auth_header_enabled),
    },
    {
      key: "api_read_only",
      label: ru.server.security.postureFields.apiReadOnly,
      state: "muted",
      text: yn(posture.api_read_only),
    },
    {
      key: "proxy_protocol_enabled",
      label: ru.server.security.postureFields.proxyProtocolEnabled,
      state: "muted",
      text: yn(posture.proxy_protocol_enabled),
    },
    {
      key: "telemetry_core_enabled",
      label: ru.server.security.postureFields.telemetryCoreEnabled,
      state: "muted",
      text: yn(posture.telemetry_core_enabled),
    },
    {
      key: "telemetry_user_enabled",
      label: ru.server.security.postureFields.telemetryUserEnabled,
      state: "muted",
      text: yn(posture.telemetry_user_enabled),
    },
  ];
}
