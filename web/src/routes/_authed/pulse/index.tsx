import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "../../../overview/OverviewPage";

export const Route = createFileRoute("/_authed/pulse/")({
  component: OverviewPage,
});
