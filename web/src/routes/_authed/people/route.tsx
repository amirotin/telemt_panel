import { createFileRoute, Outlet } from "@tanstack/react-router";

// Pathless-in-effect layout for /people and /people/$username — the
// `_authed` guard already covers auth for the whole subtree; this route
// exists only so TanStack Router's file convention can nest an index
// (list) route and a $username (detail) route under one URL prefix.
export const Route = createFileRoute("/_authed/people")({
  component: Outlet,
});
