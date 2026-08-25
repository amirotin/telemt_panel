import { createFileRoute } from "@tanstack/react-router";
import { ConfigPage } from "../../../server/config/ConfigPage";

export const Route = createFileRoute("/_authed/server/config")({
  component: ConfigPage,
});
