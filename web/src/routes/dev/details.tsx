import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { validateDetailSearch } from "../../pulse/details-builder/state";

// /dev/details — DEV-only harness for the Details-page builder (Task 3).
// Same exclusion mechanism as /dev/ui: import.meta.env.DEV is a
// compile-time constant Vite replaces with `false` in a production build,
// so this ternary's `true` branch — the dynamic import of
// ../../dev/DetailsShowcase and therefore the fixtures it renders — is dead
// code Rollup drops entirely rather than a chunk shipped but unused.
const Showcase = import.meta.env.DEV
  ? lazy(() => import("../../dev/DetailsShowcase"))
  : null;

export const Route = createFileRoute("/dev/details")({
  // The builder keeps the selected entity and tab in the URL (ruling R3),
  // so the route has to accept them — validateDetailSearch is total, and
  // junk degrades to "no selection" rather than throwing.
  validateSearch: validateDetailSearch,
  component: DevDetailsRoute,
});

function DevDetailsRoute() {
  if (!Showcase) return null;
  return (
    <Suspense fallback={null}>
      <Showcase />
    </Suspense>
  );
}
