import { createFileRoute, Outlet } from "@tanstack/react-router";

// Pathless-in-effect layout for /server and its five subpages — same
// convention as people/route.tsx and pulse/route.tsx: `_authed` already
// covers auth, this route only exists so TanStack Router's file convention
// can nest an index (menu) route and five leaf subpage routes under one
// prefix.
export const Route = createFileRoute("/_authed/server")({
  component: Outlet,
});
