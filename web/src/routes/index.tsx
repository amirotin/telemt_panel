import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getHealthOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import { ru } from "../i18n/ru";
import { StatePill, type State } from "../ui/StatePill";
import { Skeleton } from "../ui/Skeleton";
import { ThemeToggle } from "../components/ThemeToggle";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

// IndexPage is the M3 plumbing proof: theme toggle + a health badge from
// GET /api/health (unauthenticated, via the generated client/query hook).
// Task 4 replaces this with the real "Люди" landing screen behind auth.
function IndexPage() {
  const health = useQuery(getHealthOptions());

  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-6 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold text-text">{ru.app.title}</h1>

      {health.isPending && <Skeleton className="h-7 w-32" />}
      {health.isError && <StatePill state="error">{ru.common.error}</StatePill>}
      {health.isSuccess && (
        <StatePill state={healthPillState(health.data.status)}>
          {health.data.status === "ok" ? ru.health.ok : health.data.status} · v
          {health.data.version}
        </StatePill>
      )}

      <ThemeToggle />
    </main>
  );
}

function healthPillState(status: string): State {
  return status === "ok" ? "ok" : "muted";
}
