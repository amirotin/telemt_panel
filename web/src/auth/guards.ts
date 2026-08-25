import { redirect } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { getMeOptions, getMeQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";

export { getMeQueryKey };

// requireAuth is the guard every authed route's beforeLoad calls: it
// ensures GET /api/auth/me has resolved (served from cache when a sibling
// route already loaded it this navigation — TanStack Query dedupes) and
// redirects to /login?redirect=<currentHref> on failure (05-auth.md's
// session model — RequireSession's 401 dropped straight to the client, no
// separate "checking session" screen in between).
export async function requireAuth(queryClient: QueryClient, currentHref: string): Promise<void> {
  try {
    await queryClient.ensureQueryData(getMeOptions());
  } catch {
    throw redirect({ to: "/login", search: { redirect: currentHref } });
  }
}

// redirectIfAuthenticated is /login's own beforeLoad guard — an
// already-signed-in admin visiting /login is bounced straight to the
// landing section (or wherever the `redirect` search param points).
export async function redirectIfAuthenticated(
  queryClient: QueryClient,
  redirectTo: string | undefined,
): Promise<void> {
  try {
    await queryClient.ensureQueryData(getMeOptions());
  } catch {
    return; // not authenticated — let /login render.
  }
  // `href` (not `to`) — redirectTo comes from the `redirect` search param,
  // an arbitrary string outside the router's typed literal-route union.
  throw redirect({ href: redirectTo ?? "/people" });
}
