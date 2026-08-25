import { ru } from "../i18n/ru";
import type { UsersTopicQuotaEntry, UsersTopicUser } from "../realtime/topics";

// UserStatus is the single status vocabulary the card/table/detail header
// render via <StatePill> (06-ui.md §Люди: "активен/истёк/квота исчерпана").
// Priority when several conditions hold at once (checked top to bottom):
// an explicit admin action (disabled) outranks a time-based condition
// (expired), which outranks quota exhaustion, which outranks merely being
// absent from the running Telemt process (in_runtime=false — can happen for
// an enabled, unexpired, under-quota user whose config hasn't been picked
// up yet) — "active" is what's left once nothing else applies.
export type UserStatus = "disabled" | "expired" | "quota_exhausted" | "not_in_runtime" | "active";

export interface UserQuotaView {
  usedBytes: number;
  /** null means unlimited — no quota entry and no data_quota_bytes limit. */
  limitBytes: number | null;
}

// getUserQuota picks the quota figures to show: an entry in the "users"
// topic's quota map (present only when the quota capability is on AND this
// user has a quota configured — httpapi's quotaListOrDegrade/buildUserResponse
// applies the same rule) always wins, since it's Telemt's own tracked usage
// counter; otherwise this falls back to the best signal actually available —
// the user's own data_quota_bytes limit against total_octets (cumulative
// traffic since the user was created, not since a quota reset, but the
// closest approximation without the quota capability).
export function getUserQuota(
  user: Pick<UsersTopicUser, "data_quota_bytes" | "total_octets">,
  quotaEntry: UsersTopicQuotaEntry | undefined,
): UserQuotaView {
  if (quotaEntry) {
    return { usedBytes: quotaEntry.used_bytes, limitBytes: quotaEntry.data_quota_bytes };
  }
  return { usedBytes: user.total_octets, limitBytes: user.data_quota_bytes ?? null };
}

export function isQuotaExhausted(quota: UserQuotaView): boolean {
  return quota.limitBytes !== null && quota.usedBytes >= quota.limitBytes;
}

// computeUserStatus is the ONE status computation every screen (list card,
// table row, detail header) goes through — see UserStatus's doc comment for
// the priority order. Expiry is inclusive of "now": a user whose expiration
// instant is exactly now is already expired, not still active for one more
// tick — there's no grace period to render differently.
export function computeUserStatus(
  user: Pick<UsersTopicUser, "enabled" | "in_runtime" | "expiration_rfc3339">,
  quota: UserQuotaView,
  nowMs: number,
): UserStatus {
  if (!user.enabled) return "disabled";
  if (user.expiration_rfc3339) {
    const expiresAt = Date.parse(user.expiration_rfc3339);
    if (!Number.isNaN(expiresAt) && expiresAt <= nowMs) return "expired";
  }
  if (isQuotaExhausted(quota)) return "quota_exhausted";
  if (!user.in_runtime) return "not_in_runtime";
  return "active";
}

export function isOnline(user: Pick<UsersTopicUser, "current_connections">): boolean {
  return user.current_connections > 0;
}

// --- quota unit conversion (create/edit form's ГБ/МБ selector) ---

export type QuotaUnit = "MB" | "GB";

const UNIT_BYTES: Record<QuotaUnit, number> = {
  MB: 1024 ** 2,
  GB: 1024 ** 3,
};

export function quotaUnitToBytes(value: number, unit: QuotaUnit): number {
  return Math.round(value * UNIT_BYTES[unit]);
}

// bytesToQuotaDisplay picks GB for anything at or above 1 GB, MB otherwise —
// the inverse of quotaUnitToBytes, rounded to 2 decimal places so re-editing
// an existing limit doesn't show 17 digits of binary-fraction noise.
export function bytesToQuotaDisplay(bytes: number): { value: number; unit: QuotaUnit } {
  const unit: QuotaUnit = bytes >= UNIT_BYTES.GB ? "GB" : "MB";
  const value = Math.round((bytes / UNIT_BYTES[unit]) * 100) / 100;
  return { value, unit };
}

// --- search / sort ---

export function filterUsersByQuery(users: UsersTopicUser[], query: string): UsersTopicUser[] {
  const q = query.trim().toLowerCase();
  if (!q) return users;
  return users.filter((u) => u.username.toLowerCase().includes(q));
}

// --- filter segments (Все / Онлайн / Проблемы) ---
//
// "Проблемы" reuses computeUserStatus rather than re-deriving the
// conditions: anything that isn't "active" is something the admin may need
// to act on (disabled / expired / quota exhausted / not loaded into the
// running proxy), which is exactly the prototype's own segment.
export type UserFilter = "all" | "online" | "issues";

export function hasIssues(status: UserStatus): boolean {
  return status !== "active";
}

export interface UserFilterCounts {
  all: number;
  online: number;
  issues: number;
}

// Generic over the user shape so a caller can pass full topic users (the
// list) or a minimal stub (tests) without either side widening.
export interface UserFilterInput<T extends Pick<UsersTopicUser, "current_connections">> {
  user: T;
  status: UserStatus;
}

export function countUserFilters<T extends Pick<UsersTopicUser, "current_connections">>(
  entries: readonly UserFilterInput<T>[],
): UserFilterCounts {
  let online = 0;
  let issues = 0;
  for (const entry of entries) {
    if (isOnline(entry.user)) online++;
    if (hasIssues(entry.status)) issues++;
  }
  return { all: entries.length, online, issues };
}

export function matchesUserFilter<T extends Pick<UsersTopicUser, "current_connections">>(
  entry: UserFilterInput<T>,
  filter: UserFilter,
): boolean {
  if (filter === "online") return isOnline(entry.user);
  if (filter === "issues") return hasIssues(entry.status);
  return true;
}

export type UserSortField = "name" | "traffic" | "connections";
export type SortDirection = "asc" | "desc";

export interface UserSortState {
  field: UserSortField;
  direction: SortDirection;
}

export function sortUsers(users: UsersTopicUser[], sort: UserSortState): UsersTopicUser[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  return [...users].sort((a, b) => {
    switch (sort.field) {
      case "name":
        return dir * a.username.localeCompare(b.username);
      case "traffic":
        return dir * (a.total_octets - b.total_octets);
      case "connections":
        return dir * (a.current_connections - b.current_connections);
      default:
        return 0;
    }
  });
}

// --- sort presets (the list header's Активность / Имя / Трафик chips) ---
//
// The persisted shape stays {field, direction} — the chips are just the
// three combinations the prototype offers, so a preset can be resolved
// back out of an arbitrary stored state (including one written by the old
// Select+direction control) instead of being a second stored key.
export type UserSortPreset = "activity" | "name" | "traffic";

export const SORT_PRESETS: Record<UserSortPreset, UserSortState> = {
  activity: { field: "connections", direction: "desc" },
  name: { field: "name", direction: "asc" },
  traffic: { field: "traffic", direction: "desc" },
};

export const SORT_PRESET_ORDER: readonly UserSortPreset[] = ["activity", "name", "traffic"];

// sortPresetOf returns null for a stored state that matches no chip (e.g.
// "traffic ascending", reachable through the previous direction toggle) —
// the list then shows no chip as active rather than lying about which one is.
export function sortPresetOf(sort: UserSortState): UserSortPreset | null {
  for (const preset of SORT_PRESET_ORDER) {
    const p = SORT_PRESETS[preset];
    if (p.field === sort.field && p.direction === sort.direction) return preset;
  }
  return null;
}

const SORT_STORAGE_KEY = "telemt-panel:people-sort:v1";
// Активность first, matching the prototype's default: on a 30-second phone
// session the people who are actually using the proxy right now are what
// the admin came to see, not the alphabet.
export const DEFAULT_USER_SORT: UserSortState = SORT_PRESETS.activity;

function isSortField(v: unknown): v is UserSortField {
  return v === "name" || v === "traffic" || v === "connections";
}

function isSortDirection(v: unknown): v is SortDirection {
  return v === "asc" || v === "desc";
}

// getStoredUserSort/setStoredUserSort follow the same versioned-key +
// try/catch-fallback pattern as display-mode/mode.ts's persistence, so a
// garbage value or a throwing localStorage (private mode) degrades to the
// default instead of crashing the list page.
export function getStoredUserSort(): UserSortState {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        isSortField((parsed as { field?: unknown }).field) &&
        isSortDirection((parsed as { direction?: unknown }).direction)
      ) {
        return parsed as UserSortState;
      }
    }
  } catch {
    // localStorage unavailable or garbage JSON — fall back to the default.
  }
  return DEFAULT_USER_SORT;
}

export function setStoredUserSort(sort: UserSortState): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // Best-effort, see getStoredUserSort.
  }
}

// formatBitsPerSecond renders rate_limit_up_bps/rate_limit_down_bps —
// decimal (1000-based) SI units, matching networking convention for
// bitrates (Kbps/Mbps), unlike formatBytes' binary (1024-based) byte units.
// Unit labels live in ru.people.bitrateUnits (i18n/ru.ts), not here.
export function formatBitsPerSecond(bps: number): string {
  const units = ru.people.bitrateUnits;
  let value = bps;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

// --- validation ---

// USERNAME_PATTERN mirrors api/openapi.yaml's Username parameter and
// UserCreate.username pattern exactly.
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function isValidUsername(name: string): boolean {
  return USERNAME_PATTERN.test(name);
}

// SECRET_PATTERN mirrors UserCreate.secret / UserPatch.secret's pattern.
export const SECRET_PATTERN = /^[0-9a-fA-F]{32}$/;

export function isValidSecret(secret: string): boolean {
  return SECRET_PATTERN.test(secret);
}
