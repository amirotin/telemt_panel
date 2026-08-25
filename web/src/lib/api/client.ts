import { client } from "./generated/client.gen";
import { getMeQueryKey } from "./generated/@tanstack/react-query.gen";
import { getBasePath, withBasePath } from "../base-path";
import { getRouterInstance } from "../router-instance";
import { queryClient } from "../query-client";

// Wires the hey-api generated client to this deployment: same-origin
// requests carry the session cookie (`credentials: "include"` — the panel
// authenticates via an HttpOnly cookie, see 05-auth.md), and every request
// is prefixed with the base_path injected by internal/webui so this works
// unmodified whether the panel is served at "/" or under a reverse-proxy
// sub-path like "/panel".
client.setConfig({
  // "" is valid (root deployment) — the generated client concatenates
  // baseUrl + path directly (see generated/client/utils.gen.ts), so an
  // empty prefix and no trailing slash is exactly right, matching
  // config.Config.BasePath's own normalization.
  baseUrl: getBasePath(),
  credentials: "include",
});

// Global 401 handling (Task 4 deliverable A): any authenticated request
// that comes back 401 mid-session (RequireSession's session_expired —
// 05-auth.md) drops the app to /login exactly once. /api/auth/login's own
// 401 (bad credentials) and /api/auth/me's own 401 are excluded — the login
// form and the route guards (auth/guards.ts) already handle those
// specifically and more precisely. `redirecting` guards against a burst of
// concurrent requests all failing at once triggering repeat navigations —
// it clears on the next non-401 response, so a fresh session (re-login)
// re-arms it.
const EXCLUDED_PATHS = [withBasePath("/api/auth/login"), withBasePath("/api/auth/me")];
let redirecting = false;

client.interceptors.response.use((response, request) => {
  if (response.status !== 401) {
    if (response.ok) redirecting = false;
    return response;
  }

  const requestUrl = new URL(request.url);
  if (EXCLUDED_PATHS.some((p) => requestUrl.pathname.endsWith(p))) {
    return response;
  }

  if (!redirecting) {
    redirecting = true;
    queryClient.removeQueries({ queryKey: getMeQueryKey() });
    const router = getRouterInstance();
    if (router) {
      const redirectTarget = window.location.pathname + window.location.search;
      void router.navigate({ to: "/login", search: { redirect: redirectTarget } });
    }
  }
  return response;
});

export { client };
