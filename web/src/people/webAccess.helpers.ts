import type { WebAccessView, WebUserAccessProfile } from "../lib/api/generated/types.gen";

export function webProfilesForUser(
  access: WebAccessView | undefined,
  username: string,
): WebUserAccessProfile[] {
  if (!access) return [];
  return access.vhosts.flatMap((vhost) =>
    vhost.profiles
      .filter((profile) => profile.user === username)
      .map(({ user: _user, ...profile }) => ({ vhost: vhost.host, ...profile })),
  );
}

export function webAccessUsernames(access: WebAccessView | undefined): Set<string> {
  const usernames = new Set<string>();
  for (const vhost of access?.vhosts ?? []) {
    for (const profile of vhost.profiles) usernames.add(profile.user);
  }
  return usernames;
}

export function hasDuplicateWebProfiles(profiles: readonly WebUserAccessProfile[]): boolean {
  const keys = new Set<string>();
  for (const profile of profiles) {
    const key = `${profile.vhost}\u0000${profile.secret_mode}`;
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}
