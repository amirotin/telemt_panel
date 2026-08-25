import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "../../ui/EmptyState";
import { ru } from "../../i18n/ru";

// Placeholder — Task 6 fills this in with the widget dashboard.
export const Route = createFileRoute("/_authed/pulse")({
  component: () => <EmptyState title={ru.nav.pulse} description={ru.shell.placeholderDescription} />,
});
