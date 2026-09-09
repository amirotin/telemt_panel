import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTrafficSummaryQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { TrafficSummary } from "../../lib/api/generated/types.gen";
import { resetLocaleForTests, setLocalePreference } from "../../i18n";
import { TrafficAnalytics } from "./TrafficAnalytics";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, hash }: { children: ReactNode; to: string; hash?: string }) => <a href={`${to}${hash ? `#${hash}` : ""}`}>{children}</a>,
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

async function renderAnalytics(reports = [report("7d"), report("month", { total_bytes: 500 })]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const data of reports) {
    queryClient.setQueryData(getTrafficSummaryQueryKey({ query: { range: data.range } }), data);
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient}><TrafficAnalytics /></QueryClientProvider>);
  });
  return { view: container, queryClient };
}

function disabledReports(collection: Partial<TrafficSummary["collection"]> = {}) {
  return (["7d", "month"] as const).map((range) => report(range, {
    state: "disabled",
    total_bytes: range === "month" ? 500 : 0,
    points: [],
    top_users: [],
    collection: { ...report(range).collection, retention_secs: 0, ...collection },
  }));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  resetLocaleForTests();
});

describe("TrafficAnalytics", () => {
  it("renders compact totals, a sparse chart, collection state, and top users", async () => {
    const { view } = await renderAnalytics();
    expect(view.textContent).toContain("Потребление трафика");
    expect(view.textContent).toContain("Сегодня (UTC)");
    expect(view.textContent).toContain("Сбор работает");
    expect(view.textContent).toContain("alice");
    expect(view.querySelector("svg")).not.toBeNull();
    expect(view.querySelectorAll('[role="group"] button')).toHaveLength(5);
  });

  it("keeps the monthly total and links to storage instead of showing unusable history controls", async () => {
    const { view } = await renderAnalytics(disabledReports());
    expect(view.textContent).toContain("Текущий месяц");
    expect(view.textContent).toContain("500");
    expect(view.textContent).toContain("Накопительный учёт работает");
    expect(view.textContent).toContain("История трафика отключена");
    expect(view.textContent).toContain("История начнёт накапливаться после включения");
    expect(view.querySelector('a[href="/server/settings#storage"]')?.textContent).toBe("Настроить хранение");
    expect(view.querySelector('[role="group"]')).toBeNull();
    expect(view.querySelector("svg")).toBeNull();
    expect(view.textContent).not.toContain("Сегодня (UTC)");
    expect(view.textContent).not.toContain("За период");
    expect(view.textContent).not.toContain("Больше всего трафика");
    expect(view.textContent).not.toContain("За выбранный период трафика пока нет");
    expect(view.textContent).not.toContain("Сбор работает");
  });

  it.each([
    ["paused", "normal", "Сбор приостановлен в Telemt"],
    ["unavailable", "normal", "Источник сейчас недоступен"],
    ["collecting", "partial", "Есть разрыв наблюдения"],
  ] as const)("preserves the %s / %s warning when history is disabled", async (source_state, continuity, message) => {
    const { view } = await renderAnalytics(disabledReports({ source_state, continuity }));
    expect(view.textContent).toContain(message);
    expect(view.textContent).not.toContain("Накопительный учёт работает");
    expect(view.textContent).toContain("500");
    expect(view.textContent).toContain("История трафика отключена");
  });

  it("distinguishes enabled but empty history from disabled history", async () => {
    const { view } = await renderAnalytics([
      report("7d", { state: "empty", points: [], top_users: [], total_bytes: 0 }),
      report("month", { state: "empty", points: [], top_users: [], total_bytes: 0 }),
    ]);
    expect(view.querySelectorAll('[role="group"] button')).toHaveLength(5);
    expect(view.textContent).toContain("За выбранный период трафика пока нет");
    expect(view.textContent).not.toContain("История трафика отключена");
  });

  it("updates the report when selecting a different period", async () => {
    const { view } = await renderAnalytics([
      report("7d"), report("month"), report("24h", { top_users: [], total_bytes: 700 }),
    ]);
    const day = view.querySelector<HTMLButtonElement>('[role="group"] button')!;
    await act(async () => day.click());
    expect(day.getAttribute("aria-pressed")).toBe("true");
    expect(view.textContent).toContain("700");
    expect(view.textContent).not.toContain("alice");
    expect(view.querySelector("svg")).not.toBeNull();
  });

  it("restores history controls after storage is enabled and the report refreshes", async () => {
    const { view, queryClient } = await renderAnalytics(disabledReports());
    await act(async () => {
      for (const range of ["7d", "month"] as const) {
        queryClient.setQueryData(getTrafficSummaryQueryKey({ query: { range } }), report(range));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.textContent).not.toContain("История трафика отключена");
    expect(view.querySelectorAll('[role="group"] button')).toHaveLength(5);
    expect(view.querySelector("svg")).not.toBeNull();
    expect(view.textContent).toContain("alice");
  });

  it("explains disabled history in English", async () => {
    setLocalePreference("en");
    const { view } = await renderAnalytics(disabledReports());
    expect(view.textContent).toContain("Traffic history is disabled");
    expect(view.textContent).toContain("Cumulative tracking is active");
    expect(view.querySelector('a[href="/server/settings#storage"]')?.textContent).toBe("Storage settings");
  });
});
