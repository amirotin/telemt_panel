import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireAuth } from "../auth/guards";
import { Shell } from "../shell/Shell";

// Pathless layout route (TanStack Router file convention: the leading `_`
// contributes no URL segment) wrapping every authed section — Люди · Пульс
// · Журнал · Сервер — in the tab-bar/sidebar shell, after checking the
// session once for the whole subtree.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    // pathname + searchStr, never location.href — the origin/scheme must
    // never travel through the `redirect` search param (see guards.ts /
    // safeRedirect.ts).
    await requireAuth(context.queryClient, location.pathname + location.searchStr);
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
