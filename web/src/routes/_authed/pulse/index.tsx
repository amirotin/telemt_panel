import { createFileRoute } from "@tanstack/react-router";
import { PulseDashboard } from "../../../pulse/PulseDashboard";

export const Route = createFileRoute("/_authed/pulse/")({
  component: PulseDashboard,
});
