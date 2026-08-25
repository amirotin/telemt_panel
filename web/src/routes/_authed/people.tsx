import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "../../ui/EmptyState";
import { ru } from "../../i18n/ru";

// Placeholder — Task 5 fills this in with the real Люди list/detail/forms.
// Still composes a standard state primitive (EmptyState) rather than a bare
// div, per the plan's "placeholders must still use the standard states".
export const Route = createFileRoute("/_authed/people")({
  component: () => <EmptyState title={ru.nav.people} description={ru.shell.placeholderDescription} />,
});
