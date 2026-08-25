import { ru } from "../i18n/ru";
import { formatBytes } from "../lib/format";
import type { UserQuotaView, UserStatus } from "./users.helpers";
import type { UsersTopicUser } from "../realtime/topics";

// personMeta.helpers.ts — the one-line summary under a person's name in
// the list row and the inspector header.
//
// The prototype's row reads «Качает 3,9 МБ/с · 2 IP», but the "users" SSE
// topic carries no throughput at all: internal/telemt.UserInfo exposes
// current_connections, active_unique_ips and total_octets (cumulative
// bytes since the user was created), and nothing that can be differentiated
// into a live bit-rate without a second sample the hub does not keep.
// Inventing one would be a lie on the busiest screen in the app, so the
// online line shows what is real instead — connections · IPs · traffic —
// in the same shape and rhythm. Whenever a rate does become available
// (a runtime_edge throughput topic), only this file has to change.

export type PersonMetaTone = "muted" | "error" | "warn" | "faint";

export interface PersonMeta {
  text: string;
  tone: PersonMetaTone;
}

export interface PersonMetaInput {
  user: Pick<UsersTopicUser, "current_connections" | "active_unique_ips">;
  status: UserStatus;
  quota: UserQuotaView;
}

function quotaPhrase(quota: UserQuotaView): string {
  if (quota.limitBytes === null) return formatBytes(quota.usedBytes);
  return `${formatBytes(quota.usedBytes)} ${ru.people.meta.of} ${formatBytes(quota.limitBytes)}`;
}

// quotaSummary is the Инспектор's «12,4 из 50 ГБ» header figure and the
// detail screen's caption under the bar — one phrasing for both, and
// unlike quotaPhrase it names an absent limit instead of staying silent
// about it (the row's meta line has no room, a quota card does).
export function quotaSummary(quota: UserQuotaView): string {
  if (quota.limitBytes === null) {
    return `${formatBytes(quota.usedBytes)} · ${ru.people.form.quotaUnlimited}`;
  }
  return quotaPhrase(quota);
}

// personMeta: the status-driven line wins over the activity line — a
// disabled or expired access is the thing to act on, and showing "2 соед"
// for it would bury that.
export function personMeta({ user, status, quota }: PersonMetaInput): PersonMeta {
  switch (status) {
    case "quota_exhausted":
      return { text: `${ru.people.meta.quotaExhausted} · ${quotaPhrase(quota)}`, tone: "error" };
    case "expired":
      return { text: ru.people.meta.expired, tone: "warn" };
    case "disabled":
      return { text: ru.people.meta.disabled, tone: "faint" };
    case "not_in_runtime":
      return { text: ru.people.meta.notInRuntime, tone: "warn" };
    case "active":
      break;
  }

  if (user.current_connections > 0) {
    const parts = [
      `${user.current_connections} ${ru.shell.connectionsShort}`,
      `${user.active_unique_ips} ${ru.people.meta.ipShort}`,
      quotaPhrase(quota),
    ];
    return { text: parts.join(" · "), tone: "muted" };
  }
  return { text: `${ru.people.meta.idle} · ${quotaPhrase(quota)}`, tone: "muted" };
}

export type PersonBadge = { text: string; tone: "accent" | "error" | "warn" | "muted" } | null;

// personBadge — the small pill at the row's right edge: the live connection
// count for someone online, a word for a state that needs attention, and
// nothing at all for an idle-but-healthy access (the prototype leaves that
// slot empty rather than printing a zero).
export function personBadge({ user, status }: Omit<PersonMetaInput, "quota">): PersonBadge {
  switch (status) {
    case "quota_exhausted":
      return { text: ru.people.badge.quota, tone: "error" };
    case "expired":
      return { text: ru.people.badge.expired, tone: "warn" };
    case "disabled":
      return { text: ru.people.badge.disabled, tone: "muted" };
    case "not_in_runtime":
      return { text: ru.people.badge.notInRuntime, tone: "warn" };
    case "active":
      break;
  }
  if (user.current_connections > 0) {
    return { text: String(user.current_connections), tone: "accent" };
  }
  return null;
}

// personAvatarTone maps a status onto Avatar's three looks: a hue for a
// healthy access, the red wash for one that has hit its quota or expired,
// and the flat idle chip for someone merely offline or switched off.
export function personAvatarTone(
  user: Pick<UsersTopicUser, "current_connections">,
  status: UserStatus,
): "hue" | "idle" | "alert" {
  if (status === "quota_exhausted" || status === "expired") return "alert";
  if (status === "disabled") return "idle";
  if (user.current_connections > 0) return "hue";
  return "idle";
}
