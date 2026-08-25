import { createFileRoute } from "@tanstack/react-router";
import { DiagDomainPage } from "../../../../pulse/diag/DiagDomainPage";

export const Route = createFileRoute("/_authed/pulse/diag/$domain")({
  component: RouteComponent,
});

function RouteComponent() {
  const { domain } = Route.useParams();
  return <DiagDomainPage domain={domain} />;
}
