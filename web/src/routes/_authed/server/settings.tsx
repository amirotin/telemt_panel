import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../../../server/settings/SettingsPage";

export const Route = createFileRoute("/_authed/server/settings")({
  component: SettingsPage,
});
