import type { SessionInfo } from "../../lib/api/generated/types.gen";
import { ru } from "../../i18n/ru";

// sortSessions puts the current session first, then orders the rest by
// most-recently-active — the list an admin scans to find a stale/unknown
// device is far more useful with the newest activity on top and "this
// device" pinned above everything else.
export function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
  });
}

// sessionDeviceLabel falls back to a generic label when the backend
// couldn't parse a User-Agent into something readable (empty/absent
// user_agent_label) — never shows a blank row.
export function sessionDeviceLabel(session: SessionInfo): string {
  const label = session.user_agent_label?.trim();
  return label ? label : ru.server.settings.unknownDevice;
}
