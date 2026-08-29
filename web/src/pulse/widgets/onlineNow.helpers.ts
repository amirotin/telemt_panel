import type { UsersTopicUser } from "../../realtime/topics";
import { isOnline } from "../../people/users.helpers";

/** One row of the «Онлайн сейчас» block — a person who has a live connection. */
export interface OnlineNowRow {
  username: string;
  connections: number;
  ips: number;
  totalOctets: number;
}

export interface OnlineNowView {
  /** People with at least one live connection right now. */
  online: number;
  /** Every access configured on the proxy — the «51 из 1 234» denominator. */
  total: number;
  /** The busiest `limit` of them, in display order. */
  rows: OnlineNowRow[];
}

/** How many names the block lists before «Все люди» takes over (prototype: five). */
export const ONLINE_NOW_LIMIT = 5;

// computeOnlineNow picks the busiest people out of the "users" topic.
//
// Presence is `isOnline` — the SAME predicate the Люди list's «Онлайн»
// segment filters by, imported rather than restated, so the two screens can
// never disagree about who is online.
//
// The order is total: connections, then cumulative traffic, then the
// username. Two people on one connection each are a common shape, and
// without the last tiebreak the block would reshuffle their rows on every
// realtime frame purely because the topic's array order moved.
export function computeOnlineNow(
  users: readonly UsersTopicUser[] | null | undefined,
  limit: number = ONLINE_NOW_LIMIT,
): OnlineNowView {
  if (!users) return { online: 0, total: 0, rows: [] };
  const online = users.filter(isOnline);
  const rows = [...online]
    .sort(
      (a, b) =>
        b.current_connections - a.current_connections ||
        b.total_octets - a.total_octets ||
        a.username.localeCompare(b.username),
    )
    .slice(0, Math.max(0, limit))
    .map((user) => ({
      username: user.username,
      connections: user.current_connections,
      ips: user.active_unique_ips,
      totalOctets: user.total_octets,
    }));
  return { online: online.length, total: users.length, rows };
}
