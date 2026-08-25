import { createFileRoute } from "@tanstack/react-router";
import { ServerMenu } from "../../../server/ServerMenu";

export const Route = createFileRoute("/_authed/server/")({
  component: ServerMenu,
});
