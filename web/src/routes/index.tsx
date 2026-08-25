import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAuth } from "../auth/guards";

// "/" always redirects: to /people (the landing section — 06-ui.md) when
// authenticated, to /login otherwise. requireAuth itself throws the
// /login redirect on failure; on success this route redirects onward to
// /people, so it never actually renders a component.
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    await requireAuth(context.queryClient, "/people");
    throw redirect({ to: "/people" });
  },
});
