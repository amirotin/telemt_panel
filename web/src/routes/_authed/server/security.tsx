import { createFileRoute } from "@tanstack/react-router";
import { SecurityPage } from "../../../server/security/SecurityPage";

export const Route = createFileRoute("/_authed/server/security")({
  component: SecurityPage,
});
