import { createFileRoute } from "@tanstack/react-router";
import { PeopleList } from "../../../people/PeopleList";

export const Route = createFileRoute("/_authed/people/")({
  component: PeopleList,
});
