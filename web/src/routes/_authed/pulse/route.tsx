import { createFileRoute, Outlet } from "@tanstack/react-router";

// Pathless-in-effect layout for /pulse and /pulse/diag/$domain — same
// convention as people/route.tsx: the `_authed` guard already covers auth,
// this route only exists so TanStack Router's file convention can nest an
// index (dashboard) route and a $domain (drill-down) route under one prefix.
export const Route = createFileRoute("/_authed/pulse")({
  component: Outlet,
});
