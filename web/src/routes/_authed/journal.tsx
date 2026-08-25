import { createFileRoute } from "@tanstack/react-router";
import { JournalPage } from "../../journal/JournalPage";

export const Route = createFileRoute("/_authed/journal")({
  component: JournalPage,
});
