import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStorageSettingsQueryKey,
  getTrafficSummaryQueryKey,
  getUserIpHistoryQueryKey,
  getUserTrafficHistoryQueryKey,
  getUserQueryKey,
  listUsersQueryKey,
  getGeographyQueryKey,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { StorageSettings as StorageSettingsData } from "../../lib/api/generated/types.gen";
import { StorageSettings } from "./StorageSettings";
import { ru } from "../../i18n/testing";
import { formatBytes } from "../../lib/format";

const { getStorageRequest, resetAllTrafficRequest, saveRequest } = vi.hoisted(() => ({
  getStorageRequest: vi.fn(),
  resetAllTrafficRequest: vi.fn().mockResolvedValue(undefined),
  saveRequest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/api/generated/@tanstack/react-query.gen", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api/generated/@tanstack/react-query.gen")>();
  return {
    ...original,
    getStorageSettingsOptions: (
      options?: Parameters<typeof original.getStorageSettingsOptions>[0],
    ) => ({
      queryKey: original.getStorageSettingsQueryKey(options),
      queryFn: getStorageRequest,
    }),
    putStorageSettingsMutation: () => ({ mutationFn: saveRequest }),
    resetAllUserTrafficMutation: () => ({ mutationFn: resetAllTrafficRequest }),
  };
});

describe("StorageSettings per-user IP cap", () => {
  const data: StorageSettingsData = {
    policies: [
      { category: "user_ip_history", enabled: true, retention_days: 30 },
      { category: "technical", enabled: true, retention_days: 7 },
    ],
    state_durable: true,
    stats: { driver: "sqlite", durable: true, database_bytes: 0, categories: [] },
  };
  function withLimit(limit: number | null): StorageSettingsData {
    return { ...data, policies: data.policies.map((p) => p.category === "user_ip_history" ? { ...p, max_ips_per_user: limit } : p) };
  }
  function limitField(view: HTMLElement) {
    const field = view.querySelector<HTMLInputElement>('input[aria-label="Адресов на пользователя"]');
    expect(field).not.toBeNull();
    return field!;
  }
  function saveButton(view: HTMLElement) {
    return [...view.querySelectorAll("button")].find((b) => b.textContent === "Сохранить")!;
  }
  function unlimitedToggle(view: HTMLElement) {
    const toggle = view.querySelector<HTMLButtonElement>('[aria-label="Без лимита на пользователя"]');
    expect(toggle).not.toBeNull();
    return toggle!;
  }
  async function enterLimit(view: HTMLElement, value: string) {
    const field = limitField(view);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it.each([undefined, null, 512])("shows the effective limit for %s without creating an edit", async (limit) => {
    const view = await renderStorage(limit === undefined ? data : withLimit(limit));
    expect(limitField(view).value).toBe(String(limit ?? 256));
    expect(unlimitedToggle(view).getAttribute("aria-checked")).toBe("false");
    expect(saveButton(view).disabled).toBe(true);
    expect(view.textContent).toContain("20 000");
    expect(view.textContent).toContain("100 000");
  });

  it("saves a numeric cap only on the IP policy and refreshes dependent views", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const keys = [
      getUserIpHistoryQueryKey({ path: { username: "alice" }, query: { range: "7d" } }),
      getUserQueryKey({ path: { username: "alice" } }),
      listUsersQueryKey(),
    ];
    keys.forEach((key) => client.setQueryData(key, { cached: true }));
    const geoKey = getGeographyQueryKey({ query: { range: "30d", family: "all" } });
    client.setQueryData(geoKey, { cached: true });
    const view = await renderStorage(data, client, true);
    await enterLimit(view, "512");
    await act(async () => { saveButton(view).click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(saveRequest).toHaveBeenCalledOnce();
    expect(saveRequest.mock.calls[0][0].body).toEqual({ policies: withLimit(512).policies });
    keys.forEach((key) => expect(client.getQueryState(key)?.isInvalidated).toBe(true));
    expect(client.getQueryData(geoKey)).toBeUndefined();
    expect(getStorageRequest).toHaveBeenCalled();
  });

  it("uses an explicit unlimited switch and restores the typed finite limit", async () => {
    const view = await renderStorage(data);
    await enterLimit(view, "768");
    await act(async () => unlimitedToggle(view).click());
    expect(unlimitedToggle(view).getAttribute("aria-checked")).toBe("true");
    expect(limitField(view).disabled).toBe(true);
    await act(async () => unlimitedToggle(view).click());
    expect(limitField(view).value).toBe("768");
    await act(async () => unlimitedToggle(view).click());
    await act(async () => saveButton(view).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(saveRequest.mock.calls[0][0].body).toEqual({ policies: withLimit(0).policies });
  });

  it.each(["", "0", "-1", "1.5", "100001", "invalid"])("blocks the invalid finite draft %s even with other pending edits", async (value) => {
    const view = await renderStorage(data);
    const metricsToggle = view.querySelector<HTMLButtonElement>('[aria-label="Технические метрики"]')!;
    await act(async () => metricsToggle.click());
    await enterLimit(view, value);
    expect(limitField(view).getAttribute("aria-invalid")).toBe("true");
    expect(saveButton(view).disabled).toBe(true);
    await act(async () => saveButton(view).click());
    expect(saveRequest).not.toHaveBeenCalled();
    expect(unlimitedToggle(view).getAttribute("aria-checked")).toBe("false");
  });

  it.each([256, 0])("confirms reducing cap %i before sending the mutation", async (previous) => {
    const view = await renderStorage(withLimit(previous));
    if (previous === 0) await act(async () => unlimitedToggle(view).click());
    await enterLimit(view, "1");
    await act(async () => saveButton(view).click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Адресов на пользователя");
    expect(dialog!.textContent).toContain(previous === 0 ? "Без лимита" : "256");
    expect(dialog!.textContent).not.toContain("30 → 30");
    expect(saveRequest).not.toHaveBeenCalled();
    await act(async () => saveButton(dialog as HTMLElement).click());
    expect(saveRequest.mock.calls[0][0].body).toEqual({ policies: withLimit(1).policies, confirm_retention_reduction: true });
  });

  it("accepts the upper bound and preserves a typed draft across background refresh", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const view = await renderStorage(data, client);
    await enterLimit(view, "100000");
    await act(async () => client.setQueryData(getStorageSettingsQueryKey(), withLimit(1024)));
    expect(limitField(view).value).toBe("100000");
    expect(saveButton(view).disabled).toBe(false);
    await act(async () => saveButton(view).click());
    expect(saveRequest.mock.calls[0][0].body).toEqual({ policies: withLimit(100000).policies });
  });

  it("freezes policy edits during saving and preserves the draft if the request fails", async () => {
    let rejectSave!: (error: Error) => void;
    saveRequest.mockReturnValueOnce(new Promise<never>((_resolve, reject) => { rejectSave = reject; }));
    const view = await renderStorage(data);
    async function waitForLimitDisabled(disabled: boolean) {
      const deadline = Date.now() + 1000;
      while (limitField(view).disabled !== disabled && Date.now() < deadline) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      expect(limitField(view).disabled).toBe(disabled);
    }
    await enterLimit(view, "512");
    await act(async () => saveButton(view).click());

    try {
      await waitForLimitDisabled(true);
      expect(saveRequest).toHaveBeenCalledOnce();
      expect(unlimitedToggle(view).disabled).toBe(true);
      expect([...view.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);
      expect(view.querySelector<HTMLButtonElement>('[aria-label="Технические метрики"]')!.disabled).toBe(true);
    } finally {
      await act(async () => rejectSave(new Error("save failed")));
    }

    await waitForLimitDisabled(false);
    expect(limitField(view).value).toBe("512");
    expect(unlimitedToggle(view).disabled).toBe(false);
    expect(view.querySelector<HTMLButtonElement>('[aria-label="Технические метрики"]')!.disabled).toBe(false);
    expect(saveButton(view).disabled).toBe(false);
  });
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderStorage(
  data: StorageSettingsData,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  }),
  realInvalidation = false,
) {
  getStorageRequest.mockResolvedValue(data);
  if (!realInvalidation) vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
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
  getStorageRequest.mockReset();
  resetAllTrafficRequest.mockReset();
  resetAllTrafficRequest.mockResolvedValue(undefined);
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
    expect(dialog.textContent).toContain(ru.server.settings.storageReduceTitle);
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

  it("refreshes all users' traffic views without touching IP history after a global reset", async () => {
    const resetData: StorageSettingsData = {
      ...data,
      stats: {
        ...data.stats,
        categories: data.stats.categories.map((entry) =>
          entry.category === "user_traffic" ? { ...entry, entities: 2 } : entry,
        ),
      },
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    const historyKey = getUserTrafficHistoryQueryKey({
      path: { username: "bob" },
      query: { range: "7d" },
    });
    const ipKey = getUserIpHistoryQueryKey({
      path: { username: "bob" },
      query: { range: "7d" },
    });
    const summaryKey = getTrafficSummaryQueryKey({ query: { range: "month" } });
    queryClient.setQueryData(historyKey, { cached: "history" });
    queryClient.setQueryData(ipKey, { cached: "ip" });
    queryClient.setQueryData(summaryKey, { cached: "summary" });
    let historyRefetches = 0;
    let ipRefetches = 0;
    const historyObserver = new QueryObserver(queryClient, {
      queryKey: historyKey,
      queryFn: async () => ({ fetch: ++historyRefetches }),
      staleTime: Infinity,
    });
    const ipObserver = new QueryObserver(queryClient, {
      queryKey: ipKey,
      queryFn: async () => ({ fetch: ++ipRefetches }),
      staleTime: Infinity,
    });
    const unsubscribeHistory = historyObserver.subscribe(() => {});
    const unsubscribeIP = ipObserver.subscribe(() => {});

    const view = await renderStorage(resetData, queryClient, true);
    const openConfirmation = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === ru.server.settings.storageTrafficReset,
    );
    if (!openConfirmation) throw new Error("global traffic reset action button not found");
    await act(async () => openConfirmation.click());
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("global traffic reset confirmation dialog not found");
    const confirm = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === ru.server.settings.storageTrafficReset,
    );
    if (!confirm) throw new Error("global traffic reset confirmation button not found");

    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(resetAllTrafficRequest).toHaveBeenCalledOnce();
    expect(historyRefetches).toBe(1);
    expect(ipRefetches).toBe(0);
    expect(queryClient.getQueryState(summaryKey)?.isInvalidated).toBe(true);
    unsubscribeHistory();
    unsubscribeIP();
  });

  it("leaves cached traffic queries untouched when the global reset fails", async () => {
    resetAllTrafficRequest.mockRejectedValueOnce(new Error("reset failed"));
    const resetData: StorageSettingsData = {
      ...data,
      stats: {
        ...data.stats,
        categories: data.stats.categories.map((entry) =>
          entry.category === "user_traffic" ? { ...entry, entities: 2 } : entry,
        ),
      },
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    const summaryKey = getTrafficSummaryQueryKey({ query: { range: "30d" } });
    queryClient.setQueryData(summaryKey, { cached: "summary" });

    const view = await renderStorage(resetData, queryClient, true);
    const openConfirmation = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === ru.server.settings.storageTrafficReset,
    );
    if (!openConfirmation) throw new Error("global traffic reset action button not found");
    await act(async () => openConfirmation.click());
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("global traffic reset confirmation dialog not found");
    const confirm = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === ru.server.settings.storageTrafficReset,
    );
    if (!confirm) throw new Error("global traffic reset confirmation button not found");

    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(resetAllTrafficRequest).toHaveBeenCalledOnce();
    expect(queryClient.getQueryState(summaryKey)?.isInvalidated).toBe(false);
  });
});
