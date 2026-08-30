import { createFileRoute } from "@tanstack/react-router";
import { DiagDomainPage } from "../../../../pulse/diag/DiagDomainPage";
import { validateDetailSearch } from "../../../../pulse/details-builder/state";

export const Route = createFileRoute("/_authed/pulse/diag/$domain")({
  component: RouteComponent,
  // The Details pages keep the selected entity and tab in the URL (ruling
  // R3) and read them back through useDetailSearch's `strict: false` hook,
  // which works whether or not the route declares them. Declaring them here
  // is what lets a LINK carry one: Сводка's DC nodes open the diagnostics
  // page on the data center that was clicked. validateDetailSearch is
  // total — junk in the URL degrades to "no selection", never a throw.
  validateSearch: validateDetailSearch,
});

function RouteComponent() {
  const { domain } = Route.useParams();
  return <DiagDomainPage domain={domain} />;
}
