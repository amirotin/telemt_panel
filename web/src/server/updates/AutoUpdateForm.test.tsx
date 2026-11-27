import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { AutoUpdateForm } from "./AutoUpdateForm";
import { client as apiClient } from "../../lib/api/client";
import { getAutoUpdateQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { AutoUpdateSettings } from "../../lib/api/generated/types.gen";
import { pushToast } from "../../ui/Toast";

vi.mock("../../ui/Toast", () => ({ pushToast: vi.fn() }));
const initial: AutoUpdateSettings = { telemt: "off", panel: "off", interval: "6h" };
const originalConfig = apiClient.getConfig();
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
async function setup() {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(getAutoUpdateQueryKey(), initial);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={cache}><AutoUpdateForm canApply /></QueryClientProvider>));
}
const radio = (index: number) => document.querySelector('[role="radiogroup"]')!.children[index] as HTMLButtonElement;
const save = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Сохранить" || button.textContent === "Сохранено")!;
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); cache?.clear(); apiClient.setConfig(originalConfig); vi.clearAllMocks(); });

it("keeps changes made during PUT dirty until those changes are saved (A06)", async () => {
  let sent: AutoUpdateSettings | undefined;
  let finish!: () => void;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    if ((request as Request).method === "PUT") { sent = await (request as Request).json(); await new Promise<void>((resolve) => { finish = resolve; }); return new Response(null, { status: 204 }); }
    return Response.json(sent ?? initial);
  } });
  await setup(); await act(async () => radio(1).click());
  await act(async () => { save().click(); await settle(); });
  expect(sent?.telemt).toBe("check");
  await act(async () => radio(2).click());
  await act(async () => { finish(); await settle(); });
  expect(radio(2).getAttribute("aria-checked")).toBe("true");
  expect(save().disabled).toBe(false);
  expect(save().textContent).toBe("Сохранить");
  expect(pushToast).not.toHaveBeenCalled();
});

it("accepts the canonical GET after a 204 save when there are no late edits", async () => {
  const canonical: AutoUpdateSettings = { telemt: "check", panel: "off", interval: "12h0m0s" };
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => (request as Request).method === "PUT" ? new Response(null, { status: 204 }) : Response.json(canonical) });
  await setup(); await act(async () => radio(1).click());
  await act(async () => { save().click(); await settle(); });
  expect(document.querySelector("select")!.value).toBe("12");
  expect(save().disabled).toBe(true);
});

it("accepts clean GET refreshes but preserves dirty input on external changes", async () => {
  await setup();
  await act(async () => { cache.setQueryData(getAutoUpdateQueryKey(), { ...initial, interval: "12h" }); await settle(); });
  expect(document.querySelector("select")!.value).toBe("12");
  await act(async () => radio(2).click());
  await act(async () => { cache.setQueryData(getAutoUpdateQueryKey(), { ...initial, interval: "24h" }); await settle(); });
  expect(document.querySelector("select")!.value).toBe("12");
  expect(radio(2).getAttribute("aria-checked")).toBe("true");
  expect(save().textContent).toBe("Сохранить");
});

it("keeps dirty AutoUpdate settings mounted when a background GET fails", async () => {
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async () => { throw new Error("offline"); } });
  await setup(); await act(async () => radio(2).click());
  await act(async () => { await cache.refetchQueries({ queryKey: getAutoUpdateQueryKey() }); await settle(); });
  expect(container.querySelectorAll('[role="radio"]')[2]?.getAttribute("aria-checked")).toBe("true");
  expect(save()?.disabled).toBe(false);
});

it.each([false, true])("reconciles an external pre-save snapshot after the authoritative GET while preserving late edits=%s", async (lateEdit) => {
  let stored: AutoUpdateSettings = initial;
  let finishPut!: () => void;
  let finishGet!: () => void;
  const submitted: AutoUpdateSettings = { telemt: "check", panel: "off", interval: "6h" };
  const external: AutoUpdateSettings = { telemt: "off", panel: "apply", interval: "24h" };
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    if ((request as Request).method === "PUT") {
      const sent = await (request as Request).json();
      await new Promise<void>((resolve) => { finishPut = resolve; });
      stored = sent;
      return new Response(null, { status: 204 });
    }
    await new Promise<void>((resolve) => { finishGet = resolve; });
    return Response.json(stored);
  } });
  await setup(); await act(async () => radio(1).click());
  await act(async () => { save().click(); await settle(); });
  await act(async () => { cache.setQueryData(getAutoUpdateQueryKey(), external); await settle(); });
  expect(container.textContent).toContain("Настройки изменились на сервере");
  if (lateEdit) await act(async () => radio(2).click());
  await act(async () => { finishPut(); await settle(); });
  expect(stored).toEqual(submitted);
  await act(async () => { finishGet(); await settle(); });
  expect(cache.getQueryData(getAutoUpdateQueryKey())).toEqual(submitted);
  expect(container.textContent).not.toContain("Настройки изменились на сервере");
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Загрузить серверную версию")).toBe(false);
  expect(radio(lateEdit ? 2 : 1).getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector("select")!.value).toBe("6");
  expect(save().disabled).toBe(!lateEdit);
  expect(save().textContent).toBe(lateEdit ? "Сохранить" : "Сохранено");
  if (lateEdit) expect(pushToast).not.toHaveBeenCalled();
});

it("preserves a different external snapshot received during the post-save GET", async () => {
  let stored: AutoUpdateSettings = initial;
  let finishPut!: () => void;
  let finishGet!: () => void;
  const external: AutoUpdateSettings = { telemt: "apply", panel: "off", interval: "24h" };
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    if ((request as Request).method === "PUT") {
      const sent = await (request as Request).json();
      await new Promise<void>((resolve) => { finishPut = resolve; });
      stored = sent;
      return new Response(null, { status: 204 });
    }
    const snapshot = stored;
    await new Promise<void>((resolve) => { finishGet = resolve; });
    return Response.json(snapshot);
  } });
  await setup(); await act(async () => radio(1).click());
  await act(async () => { save().click(); await settle(); });
  await act(async () => { cache.setQueryData(getAutoUpdateQueryKey(), { telemt: "off", panel: "apply", interval: "12h" }); await settle(); });
  await act(async () => { finishPut(); await settle(); });
  stored = external;
  await act(async () => { cache.setQueryData(getAutoUpdateQueryKey(), external); await settle(); });
  await act(async () => { finishGet(); await settle(); });
  expect(cache.getQueryData(getAutoUpdateQueryKey())).toEqual(external);
  expect(container.textContent).toContain("Настройки изменились на сервере");
  expect(pushToast).not.toHaveBeenCalled();
  const load = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Загрузить серверную версию")!;
  await act(async () => load().click()); await act(async () => load().click());
  expect(radio(2).getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector("select")!.value).toBe("24");
  expect(stored).toEqual(external);
});

it("keeps submitted state, late edits and the known conflict when the post-save GET fails", async () => {
  let stored: AutoUpdateSettings = initial;
  let finishPut!: () => void;
  const external: AutoUpdateSettings = { telemt: "off", panel: "apply", interval: "24h" };
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    if ((request as Request).method === "PUT") {
      const sent = await (request as Request).json();
      await new Promise<void>((resolve) => { finishPut = resolve; });
      stored = sent;
      return new Response(null, { status: 204 });
    }
    throw new Error("offline");
  } });
  await setup(); await act(async () => radio(1).click());
  await act(async () => { save().click(); await settle(); });
  await act(async () => { cache.setQueryData(getAutoUpdateQueryKey(), external); await settle(); radio(2).click(); });
  await act(async () => { finishPut(); await settle(); });
  expect(stored).toEqual({ telemt: "check", panel: "off", interval: "6h" });
  expect(radio(2).getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector("select")!.value).toBe("6");
  expect(container.textContent).toContain("Настройки изменились на сервере");
  expect(save().disabled).toBe(false);
  expect(save().textContent).toBe("Сохранить");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Настройки сохранены");
  expect(pushToast).not.toHaveBeenCalled();
});

it.each([false, true])("reconciles a matching baseline cache publication during the post-save GET with late edits=%s", async (lateEdit) => {
  let stored: AutoUpdateSettings = initial;
  let finishPut!: () => void;
  let finishGet!: () => void;
  const submitted: AutoUpdateSettings = { telemt: "check", panel: "off", interval: "6h" };
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    if ((request as Request).method === "PUT") {
      const sent = await (request as Request).json();
      await new Promise<void>((resolve) => { finishPut = resolve; });
      stored = sent;
      return new Response(null, { status: 204 });
    }
    await new Promise<void>((resolve) => { finishGet = resolve; });
    return Response.json(stored);
  } });
  await setup(); await act(async () => radio(1).click());
  await act(async () => { save().click(); await settle(); });
  await act(async () => { cache.setQueryData(getAutoUpdateQueryKey(), { telemt: "off", panel: "apply", interval: "24h" }); await settle(); });
  await act(async () => { finishPut(); await settle(); });
  if (lateEdit) await act(async () => radio(2).click());
  await act(async () => { cache.setQueryData(getAutoUpdateQueryKey(), { ...submitted, interval: "6h0m0s" }); await settle(); });
  expect(container.textContent).toContain("Настройки изменились на сервере");
  await act(async () => { finishGet(); await settle(); });
  expect(stored).toEqual(submitted);
  expect(container.textContent).not.toContain("Настройки изменились на сервере");
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Загрузить серверную версию")).toBe(false);
  expect(radio(lateEdit ? 2 : 1).getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector("select")!.value).toBe("6");
  expect(save().disabled).toBe(!lateEdit);
  expect(save().textContent).toBe(lateEdit ? "Сохранить" : "Сохранено");
  if (lateEdit) expect(pushToast).not.toHaveBeenCalled();
});

it("retries only the confirmation GET after a successful PUT and preserves subsequent edits", async () => {
  const methods: string[] = [];
  let allowRead = false;
  const canonical: AutoUpdateSettings = { ...initial, telemt: "check", interval: "12h0m0s" };
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const method = (request as Request).method;
    methods.push(method);
    if (method === "PUT") return new Response(null, { status: 204 });
    if (!allowRead) throw new Error("offline");
    return Response.json(canonical);
  } });
  await setup();
  const retry = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Повторить чтение");
  await act(async () => radio(1).click());
  await act(async () => save().click());
  expect(methods).toEqual(["PUT", "GET"]);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Настройки сохранены");
  expect(save().disabled).toBe(true);
  expect(retry()).toBeDefined();
  await act(async () => retry()!.click());
  expect(methods).toEqual(["PUT", "GET", "GET"]);
  expect(retry()).toBeDefined();
  await act(async () => radio(2).click());
  allowRead = true;
  await act(async () => { retry()!.click(); retry()!.click(); });
  expect(methods).toEqual(["PUT", "GET", "GET", "GET"]);
  expect(cache.getQueryData(getAutoUpdateQueryKey())).toEqual(canonical);
  expect(radio(2).getAttribute("aria-checked")).toBe("true");
  expect(save().disabled).toBe(false);
  expect(retry()).toBeUndefined();
  expect(pushToast).not.toHaveBeenCalled();
});

it("keeps a rejected PUT retryable as a save without offering a confirmation read", async () => {
  const methods: string[] = [];
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    methods.push((request as Request).method);
    return Response.json({ code: "internal_error" }, { status: 500 });
  } });
  await setup();
  await act(async () => radio(1).click());
  await act(async () => save().click());
  expect(methods).toEqual(["PUT"]);
  expect(container.textContent).not.toContain("Повторить чтение");
  expect(save().disabled).toBe(false);
  expect(pushToast).toHaveBeenCalledWith(expect.any(String), "error");
});

it.each(["no external change", "during PUT", "during GET"])("retains the last known settings and retries only GET after reopening: %s", async change => {
  const methods: string[] = [];
  const external: AutoUpdateSettings = { ...initial, telemt: "apply" };
  const submitted: AutoUpdateSettings = { ...initial, telemt: "check" };
  const expected = change === "no external change" ? submitted : external;
  let readable = false;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async request => {
    const method = (request as Request).method;
    methods.push(method);
    if ((method === "PUT" && change === "during PUT") || (methods.length === 2 && change === "during GET")) {
      cache.setQueryData(getAutoUpdateQueryKey(), external);
    }
    if (method === "PUT") return new Response(null, { status: 204 });
    if (!readable) throw new Error("offline");
    return Response.json({ ...expected, interval: "12h0m0s" });
  } });
  await setup();
  await act(async () => radio(1).click());
  await act(async () => save().click());
  expect(methods).toEqual(["PUT", "GET"]);
  await act(async () => root.render(null));
  await act(async () => root.render(<QueryClientProvider client={cache}><AutoUpdateForm canApply /></QueryClientProvider>));
  await act(async () => { await settle(); });
  expect(methods).toEqual(["PUT", "GET", "GET"]);
  expect(cache.getQueryData(getAutoUpdateQueryKey())).toEqual(expected);
  expect(radio(expected.telemt === "check" ? 1 : 2).getAttribute("aria-checked")).toBe("true");
  expect(save().disabled).toBe(true);
  const retry = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Повторить чтение");
  expect(retry()).toBeDefined();
  readable = true;
  await act(async () => { retry()!.click(); await settle(); });
  expect(methods).toEqual(["PUT", "GET", "GET", "GET"]);
  expect(container.querySelector("select")!.value).toBe("12");
  expect(retry()).toBeUndefined();
});

it.each([false, true])("applies a late PUT to the session that submitted it (new session: %s)", async newSession => {
  let finishPut!: () => void;
  const methods: string[] = [];
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async request => {
    const method = (request as Request).method;
    methods.push(method);
    if (method !== "PUT") throw new Error("offline");
    await new Promise<void>(resolve => { finishPut = resolve; });
    return new Response(null, { status: 204 });
  } });
  await setup();
  await act(async () => radio(1).click());
  await act(async () => save().click());
  await act(async () => root.render(null));
  if (newSession) {
    cache.clear();
    cache.setQueryData(getAutoUpdateQueryKey(), { ...initial, telemt: "apply" });
  }
  await act(async () => finishPut());
  await act(async () => root.render(<QueryClientProvider client={cache}><AutoUpdateForm canApply /></QueryClientProvider>));
  await act(async () => { await settle(); });
  expect(methods).toEqual(newSession ? ["PUT"] : ["PUT", "GET"]);
  expect(radio(newSession ? 2 : 1).getAttribute("aria-checked")).toBe("true");
  expect(save().disabled).toBe(true);
});
