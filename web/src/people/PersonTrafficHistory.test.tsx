import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { getUserTrafficHistoryQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import type { HistorySeries } from "../lib/api/generated/types.gen";
import { PersonTrafficHistory } from "./PersonTrafficHistory";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderHistory(data: HistorySeries) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(
    getUserTrafficHistoryQueryKey({ path: { username: "alice" }, query: { range: "24h" } }),
    data,
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <PersonTrafficHistory username="alice" />
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

function history(overrides: Partial<HistorySeries>): HistorySeries {
  return {
    metric: "user.traffic",
    range: "24h",
    state: "ready",
    requested_from_epoch_secs: 1,
    retention_secs: 30 * 24 * 60 * 60,
    points: [],
    ...overrides,
  };
}

describe("PersonTrafficHistory", () => {
  it("explains that optional collection is disabled", async () => {
    const view = await renderHistory(history({ state: "disabled", retention_secs: 0 }));
    expect(view.textContent).toContain("История для пользователей отключена");
    expect(view.textContent).toContain("можно включить в настройках хранения");
  });

  it("does not present an empty interval as zero traffic", async () => {
    const view = await renderHistory(history({ state: "empty" }));
    expect(view.textContent).toContain("За выбранный период трафика пока нет");
    expect(view.querySelector("svg")).toBeNull();
  });

  it("labels partial retained data and a currently unavailable source", async () => {
    const view = await renderHistory(history({
      state: "partial",
      source_available: false,
      points: [{ ts: 1, v: 1024, tier: "15m" }],
    }));
    expect(view.textContent).toContain("Telemt сейчас недоступен");
    expect(view.textContent).toContain("только за часть выбранного периода");
    expect(view.querySelector("svg")).not.toBeNull();
  });
});
