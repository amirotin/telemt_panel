import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { client as apiClient } from "../lib/api/client";
import { getGeographyQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import { GeographyView } from "./GeographyPage";
import { overview } from "./testFixtures";

it.each([null, "DE"])(
  "keeps the map and focused country row mounted during refresh (country=%s)",
  async (country) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = overview();
    const next = overview({
      snapshot_id: "00000000000000000000000000000002",
      totals: { unique_ips: 2, accounts: 2, country_count: 1, location_count: 1 },
    });
    next.countries[0].unique_ips = 2;
    next.points[0].unique_ips = 2;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const config = apiClient.getConfig();
    apiClient.setConfig({
      baseUrl: "http://localhost",
      fetch: async (request) => {
        const url = new URL((request as Request).url);
        const data = url.searchParams.get("snapshot_id") === next.snapshot_id ? next : first;
        if (data === next) await delayed;
        return Response.json(
          url.pathname.endsWith("/locations")
            ? { snapshot_id: data.snapshot_id, items: data.countries, total: 1, next_cursor: null }
            : data,
        );
      },
    });
    const rootKey = getGeographyQueryKey({ query: { range: "now", family: "all" } });
    queryClient.setQueryData(rootKey, first);
    if (country)
      queryClient.setQueryData(
        getGeographyQueryKey({ query: { snapshot_id: first.snapshot_id, country } }),
        first,
      );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const flush = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <GeographyView
              search={{ range: "now", family: "all", country, location: null, view: "map" }}
              onSearch={() => {}}
            />
          </QueryClientProvider>,
        ),
      );
      await flush();
      const map = container.querySelector(".geo-vector");
      const row = container.querySelector<HTMLButtonElement>(".geo-place-row")!;
      expect(row).not.toBeNull();
      row.focus();
      const zoom = Array.from(container.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "Приблизить",
      )!;
      act(() => zoom.click());
      const pose = map!.querySelector("g[transform]")!.getAttribute("transform");
      await act(async () => {
        queryClient.setQueryData(rootKey, next);
      });
      await flush();
      expect(container.querySelector(".geo-vector")).toBe(map);
      expect(container.querySelector(".geo-place-row")).toBe(row);
      expect(document.activeElement).toBe(row);
      expect(map!.querySelector("g[transform]")!.getAttribute("transform")).toBe(pose);
      if (country)
        expect(container.querySelector('[data-geography-stat="ips"]')?.textContent).toContain("1");
      await act(async () => {
        release();
      });
      await flush();
      expect(container.querySelector(".geo-vector")).toBe(map);
      expect(container.querySelector(".geo-place-row")).toBe(row);
      expect(document.activeElement).toBe(row);
      expect(container.querySelector('[data-geography-stat="ips"]')?.textContent).toContain("2");
    } finally {
      release();
      act(() => root.unmount());
      container.remove();
      queryClient.clear();
      apiClient.setConfig(config);
    }
  },
);
