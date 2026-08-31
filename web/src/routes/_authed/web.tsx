import { createFileRoute } from "@tanstack/react-router";
import { WebPage } from "../../pulse/diag/WebPage";

// WEB is a management section in the primary information architecture.
// The existing diagnostics URL remains valid, but the navigation no longer
// makes operators enter the generic Pulse hub to manage this subsystem.
export const Route = createFileRoute("/_authed/web")({
  component: WebRoutePage,
});

function WebRoutePage() {
  return <WebPage backTo="/server" />;
}
