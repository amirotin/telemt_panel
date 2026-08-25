import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "../../ui/EmptyState";
import { ru } from "../../i18n/ru";

// Placeholder — Task 7 fills this in with the live log/audit viewer.
export const Route = createFileRoute("/_authed/journal")({
  component: () => <EmptyState title={ru.nav.journal} description={ru.shell.placeholderDescription} />,
});
