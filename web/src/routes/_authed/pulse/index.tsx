import { createFileRoute } from "@tanstack/react-router";
import { PulseHub } from "../../../pulse/hub/PulseHub";

export const Route = createFileRoute("/_authed/pulse/")({
  component: PulseHub,
});
