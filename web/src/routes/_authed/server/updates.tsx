import { createFileRoute } from "@tanstack/react-router";
import { UpdatesPage } from "../../../server/updates/UpdatesPage";

export const Route = createFileRoute("/_authed/server/updates")({
  component: UpdatesPage,
});
