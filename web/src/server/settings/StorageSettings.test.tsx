import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStorageSettingsQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { StorageSettings as StorageSettingsData } from "../../lib/api/generated/types.gen";
import { StorageSettings } from "./StorageSettings";
import { ru } from "../../i18n";
import { formatBytes } from "../../lib/format";

const { saveRequest } = vi.hoisted(() => ({ saveRequest: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/api/generated/@tanstack/react-query.gen", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api/generated/@tanstack/react-query.gen")>();
  return { ...original, putStorageSettingsMutation: () => ({ mutationFn: saveRequest }) };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderStorage(data: StorageSettingsData) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
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
  saveRequest.mockClear();
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
      { category: "user_ip_history", enabled: true, retention_days: 30 },
      { category: "diagnostics", enabled: false, retention_days: 7 },
    ];
    const largeCount = 2_500_000;
    const view = await renderStorage({
      policies,
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
    expect(cards).toHaveLength(8);
    expect(view.querySelectorAll("select")).toHaveLength(8);
    expect(cards[0]?.querySelector("h3 + span")?.textContent).toContain("0");
    expect(view.textContent).toContain(
      new Intl.NumberFormat().format(largeCount),
    );
    const summaryValues = [...view.querySelectorAll("dl dd")].map((node) => node.textContent);
    expect(summaryValues).toContain(formatBytes(8_589_934_592, ru));
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

describe("StorageSettings independent history", () => {
  const policies: StorageSettingsData["policies"] = ["technical", "events", "connection_issues", "traffic", "diagnostics", "audit", "user_traffic", "user_ip_history"].map((category) => ({
    category: category as StorageSettingsData["policies"][number]["category"], enabled: true, retention_days: 30,
  }));
  const data: StorageSettingsData = { policies, state_durable: true, stats: {
    driver: "sqlite", durable: true, database_bytes: 1048576, categories: policies.map((p) => ({ category: p.category, records: 0 })),
  } };

  it("requires confirmation after Save, not when a shorter duration is selected", async () => {
    const view = await renderStorage(data);
    const select = view.querySelector<HTMLSelectElement>('[aria-label="Хранить: Технические метрики"]')!;
    await act(async () => { select.value = "7"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(saveRequest).not.toHaveBeenCalled();
    const save = [...view.querySelectorAll("button")].find((b) => b.textContent?.includes("Сохранить"))!;
    await act(async () => save.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Сократить срок хранения?");
    expect(saveRequest).not.toHaveBeenCalled();
    const confirm = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Сохранить")!;
    await act(async () => confirm.click());
    expect(saveRequest.mock.calls[0][0].body.confirm_retention_reduction).toBe(true);
    expect(saveRequest.mock.calls[0][0].body.policies).toEqual(data.policies.map((p) => p.category === "technical" ? { ...p, retention_days: 7 } : p));
  });

  it("preserves disabled categories and custom retention without a group conversion", async () => {
    const view = await renderStorage({ ...data, policies: data.policies.map((p) => p.category === "traffic" ? { ...p, enabled: false, retention_days: 45 } : p) });
    const traffic = view.querySelector<HTMLSelectElement>('[aria-label="Хранить: Общий трафик"]')!;
    expect(traffic.value).toBe("45");
    expect(traffic.disabled).toBe(true);
    expect(view.querySelector('[aria-label="Общий трафик"]')?.getAttribute("aria-checked")).toBe("false");
    expect(view.textContent).not.toContain("Объединить настройки");
    expect(view.textContent).not.toContain("Метрики и события на диске");
    expect(view.querySelector('[aria-label="Срок истории состояния"]')).toBeNull();
    expect(saveRequest).not.toHaveBeenCalled();
    expect(view.textContent).not.toContain("Размер недоступен");
    expect(view.textContent).not.toContain("Метрики и события на диске");
    expect(view.querySelector("dl dd")?.textContent).toBeTruthy();
    expect(saveRequest).not.toHaveBeenCalled();
  });

  it("toggling technical metrics does not change other categories", async () => {
    const view = await renderStorage(data);
    const toggle = view.querySelector<HTMLButtonElement>('[aria-label="Технические метрики"]')!;
    expect(toggle.disabled).toBe(false);
    await act(async () => toggle.click());
    const save = [...view.querySelectorAll("button")].find((b) => b.textContent === "Сохранить")!;
    await act(async () => save.click());
    expect(saveRequest.mock.calls[0][0].body.policies).toEqual(data.policies.map((p) => p.category === "technical" ? { ...p, enabled: false } : p));
  });
});
