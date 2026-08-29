import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "../../overview/OverviewPage";

// /overview — «Сводка», the configurable widget dashboard. It lived at
// /pulse through M3; M4 task 9 split the two apart, and /pulse is now the
// diagnostics hub. No redirect from the old URL is needed: /pulse still
// resolves, to the hub that the dashboard's own «Диагностика →» links
// already pointed into, and the dashboard carried no deep-link state of its
// own (its editor is component state, never a search param).
export const Route = createFileRoute("/_authed/overview")({
  component: OverviewPage,
});
