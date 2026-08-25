import { createFileRoute } from "@tanstack/react-router";
import { PlatformPage } from "../../../server/platform/PlatformPage";

export const Route = createFileRoute("/_authed/server/platform")({
  component: PlatformPage,
});
