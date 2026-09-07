import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTrafficSummaryQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { TrafficSummary } from "../../lib/api/generated/types.gen";
import { TrafficAnalytics } from "./TrafficAnalytics";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#person">{children}</a>,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function report(range: TrafficSummary["range"], overrides: Partial<TrafficSummary> = {}): TrafficSummary {
  const now = Math.floor(Date.now() / 1000);
  return {
    range,
    state: "ready",
    requested_from_epoch_secs: now - 7 * 86400,
    total_bytes: 150,
    previous_total_bytes: 100,
    points: [{ ts: now - 900, v: 150, tier: "15m" }],
    top_users: [{ username: "alice", bytes: 150, observed_total_bytes: 500, current_month_bytes: 500, continuity: "normal" }],
    collection: {
      source_state: "collecting",
      continuity: "normal",
      durability: "durable",
      retention_secs: 365 * 86400,
      observed_since_epoch_secs: now - 7 * 86400,
      observed_through_epoch_secs: now,
    },
    ...overrides,
  };
}

async function renderAnalytics() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(getTrafficSummaryQueryKey({ query: { range: "7d" } }), report("7d"));
  queryClient.setQueryData(getTrafficSummaryQueryKey({ query: { range: "month" } }), report("month", { total_bytes: 500 }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient}><TrafficAnalytics /></QueryClientProvider>);
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("TrafficAnalytics", () => {
  it("renders compact totals, a sparse chart, collection state, and top users", async () => {
    const view = await renderAnalytics();
    expect(view.textContent).toContain("Потребление трафика");
    expect(view.textContent).toContain("Сегодня (UTC)");
    expect(view.textContent).toContain("Сбор работает");
    expect(view.textContent).toContain("alice");
    expect(view.querySelector("svg")).not.toBeNull();
    expect(view.querySelectorAll('[role="group"] button')).toHaveLength(5);
  });
});
