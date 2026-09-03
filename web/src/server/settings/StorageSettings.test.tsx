import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { getStorageSettingsQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { StorageSettings as StorageSettingsData } from "../../lib/api/generated/types.gen";
import { StorageSettings } from "./StorageSettings";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderStorage(data: StorageSettingsData) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(getStorageSettingsQueryKey(), data);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <StorageSettings />
      </QueryClientProvider>,
    );
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("StorageSettings record counts", () => {
  it("renders zero and multi-million category counts without changing their meaning", async () => {
    const policies: StorageSettingsData["policies"] = [
      { category: "technical", enabled: true, retention_days: 7 },
      { category: "events", enabled: true, retention_days: 30 },
      { category: "audit", enabled: true, retention_days: 90 },
      { category: "connection_issues", enabled: true, retention_days: 14 },
      { category: "traffic", enabled: true, retention_days: 7 },
      { category: "user_traffic", enabled: false, retention_days: 30 },
      { category: "diagnostics", enabled: false, retention_days: 7 },
    ];
    const largeCount = 2_500_000;
    const view = await renderStorage({
      policies,
      configured_driver: "sqlite",
      active_driver: "sqlite",
      state_durable: true,
      stats: {
        driver: "sqlite",
        durable: true,
        database_bytes: 8_589_934_592,
        categories: policies.map((policy) => ({
          category: policy.category,
          records: policy.category === "events" ? largeCount : 0,
        })),
      },
    });

    const cards = [...view.querySelectorAll("article")];
    expect(cards).toHaveLength(7);
    expect(cards[0]?.querySelector("h3 + span")?.textContent).toContain("0");
    expect(cards[1]?.querySelector("h3 + span")?.textContent).toContain(
      new Intl.NumberFormat().format(largeCount),
    );
    const summaryValues = [...view.querySelectorAll("dl dd")].map((node) => node.textContent);
    expect(summaryValues).toContain(new Intl.NumberFormat().format(largeCount));
  });

  it("warns separately when panel state is not durable", async () => {
    const policies: StorageSettingsData["policies"] = [
      { category: "technical", enabled: true, retention_days: 7 },
      { category: "events", enabled: true, retention_days: 30 },
      { category: "audit", enabled: true, retention_days: 90 },
      { category: "connection_issues", enabled: true, retention_days: 14 },
      { category: "traffic", enabled: true, retention_days: 7 },
      { category: "user_traffic", enabled: false, retention_days: 30 },
      { category: "diagnostics", enabled: false, retention_days: 7 },
    ];
    const view = await renderStorage({
      policies,
      configured_driver: "sqlite",
      active_driver: "sqlite",
      state_durable: false,
      stats: {
        driver: "sqlite",
        durable: true,
        database_bytes: 4096,
        categories: policies.map((policy) => ({ category: policy.category, records: 0 })),
      },
    });

    expect(view.textContent).toContain("data_dir");
    expect(view.textContent).toContain("Сессии");
    expect(view.textContent).not.toContain("история хранится в RAM");
  });
});
