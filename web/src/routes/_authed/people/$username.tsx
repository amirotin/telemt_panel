import { createFileRoute } from "@tanstack/react-router";
import { PersonDetail } from "../../../people/PersonDetail";

export const Route = createFileRoute("/_authed/people/$username")({
  component: RouteComponent,
});

function RouteComponent() {
  const { username } = Route.useParams();
  return <PersonDetail username={username} />;
}
