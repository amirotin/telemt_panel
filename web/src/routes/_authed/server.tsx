import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "../../ui/EmptyState";
import { ru } from "../../i18n/ru";

// Placeholder — Task 8 fills this in with config/updates/security/platform/settings.
export const Route = createFileRoute("/_authed/server")({
  component: () => <EmptyState title={ru.nav.server} description={ru.shell.placeholderDescription} />,
});
