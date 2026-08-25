import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ToastViewport } from "../ui/Toast";

// Root layout: just the outlet + the app-wide toast viewport. Navigation
// shell (tab bar / sidebar), auth guard, and the SSE-backed status strip
// are Task 4 — this route only has to prove the router/query/embed
// plumbing works end to end.
export const Route = createRootRoute({
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
