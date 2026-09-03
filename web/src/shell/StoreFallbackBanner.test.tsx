import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import { getHealthQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import { StoreFallbackBanner } from "./StoreFallbackBanner";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderHealth(health: {
  configured_driver: "memory" | "sqlite" | "postgres" | "mysql";
  active_driver: "memory" | "sqlite" | "postgres" | "mysql";
  state_durable: boolean;
  store_error?: string;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(getHealthQueryKey(), {
    status: "ok" as const,
    version: "test",
    variant: "full" as const,
    drivers: ["memory", "sqlite", "postgres", "mysql"] as const,
    ...health,
  });
  const rootRoute = createRootRoute();
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <QueryClientProvider client={queryClient}>
        <StoreFallbackBanner />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RouterProvider router={router as never} />);
    await router.load();
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("StoreFallbackBanner", () => {
  it("stays hidden while the configured database is active", async () => {
    const element = await renderHealth({
      configured_driver: "postgres",
      active_driver: "postgres",
      state_durable: true,
    });
    expect(element.querySelector("[data-testid='store-fallback-banner']")).toBeNull();
  });

  it("explains the temporary memory fallback without implying synchronization", async () => {
    const element = await renderHealth({
      configured_driver: "postgres",
      active_driver: "memory",
      state_durable: true,
      store_error: "postgres database is unavailable",
    });
    const banner = element.querySelector("[data-testid='store-fallback-banner']");
    expect(banner?.textContent).toContain("PostgreSQL");
    expect(banner?.textContent).toContain("сессии, двухэтапный вход и настройки панели");
    expect(banner?.textContent).toContain("автоматического слияния истории не будет");
  });
});
