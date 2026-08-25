import { redirect } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { getMeOptions, getMeQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import { safeRedirectTarget } from "./safeRedirect";

export { getMeQueryKey };

// requireAuth is the guard every authed route's beforeLoad calls: it
// ensures GET /api/auth/me has resolved (served from cache when a sibling
// route already loaded it this navigation — TanStack Query dedupes) and
// redirects to /login?redirect=<currentPath> on failure (05-auth.md's
// session model — RequireSession's 401 dropped straight to the client, no
// separate "checking session" screen in between).
//
// currentPath must be a same-app path+search (pathname + search string),
// NEVER a full href — it round-trips through the `redirect` search param
// and back out through safeRedirectTarget on the other end (login.tsx /
// redirectIfAuthenticated below); storing a full href here would still be
// safe on its own, but every caller is expected to pass a path (see
// _authed.tsx: `location.pathname + location.searchStr`), and running it
// through safeRedirectTarget here too is one more layer of defense in
// depth against a caller getting that wrong.
export async function requireAuth(queryClient: QueryClient, currentPath: string): Promise<void> {
  try {
    await queryClient.ensureQueryData(getMeOptions());
  } catch {
    throw redirect({ to: "/login", search: { redirect: safeRedirectTarget(currentPath) } });
  }
}

// redirectIfAuthenticated is /login's own beforeLoad guard — an
// already-signed-in admin visiting /login is bounced straight to the
// landing section (or wherever the `redirect` search param points).
// `redirectTo` came off the wire (a URL search param an attacker fully
// controls) — safeRedirectTarget is the only thing standing between that
// and an open redirect, so it is NOT optional here.
export async function redirectIfAuthenticated(
  queryClient: QueryClient,
  redirectTo: string | undefined,
): Promise<void> {
  try {
    await queryClient.ensureQueryData(getMeOptions());
  } catch {
    return; // not authenticated — let /login render.
  }
  // `href` (not `to`) — the (now validated) target is an arbitrary in-app
  // path outside the router's typed literal-route union.
  throw redirect({ href: safeRedirectTarget(redirectTo) });
}
