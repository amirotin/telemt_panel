import { QueryClient } from "@tanstack/react-query";

// One QueryClient for the app. Realtime data (users/stats/etc.) arrives
// over SSE via the hub (Task 4's SSE client) rather than polling, so
// queries here are for one-shot/CRUD calls — a short staleTime avoids
// refetch storms on tab refocus without pretending this is the source of
// truth for live data.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});
