import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// /dev/ui — primitive showcase, replaces Storybook (06-ui.md). Excluded
// from production: import.meta.env.DEV is a compile-time constant Vite
// replaces with `false` in a production build, so this ternary's `true`
// branch — including the dynamic import() of ../../dev/UIShowcase and
// therefore every primitive it renders in every state — is dead code
// Rollup drops entirely rather than a real chunk shipped-but-unused.
const Showcase = import.meta.env.DEV ? lazy(() => import("../../dev/UIShowcase")) : null;

export const Route = createFileRoute("/dev/ui")({
  component: DevUIRoute,
});

function DevUIRoute() {
  if (!Showcase) return null;
  return (
    <Suspense fallback={null}>
      <Showcase />
    </Suspense>
  );
}
