import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { ToastViewport } from "../ui/Toast";

// RouterContext carries the app's QueryClient down to every route's
// beforeLoad (auth/guards.ts's requireAuth/redirectIfAuthenticated read it
// from `context`) — set once in main.tsx's createRouter({context}).
export interface RouterContext {
  queryClient: QueryClient;
}

// Root layout: outlet + the app-wide toast viewport. The tab bar/sidebar
// shell lives one level down, in the `_authed` layout route (shell/Shell.tsx)
// — /login renders without it.
export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div className="min-h-dvh bg-bg pt-safe">
      <Outlet />
      <ToastViewport />
    </div>
  );
}
