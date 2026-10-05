import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { TomlSettingsPanel } from "./TomlSettingsPanel";
import { client as apiClient } from "../../lib/api/client";
import { getTelemtConfigTomlQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";

vi.mock("../useIsDesktop", () => ({ useIsDesktop: () => true }));
vi.mock("./TomlConfigEditor", () => ({
  TomlConfigEditor: ({ initialText, onChange }: { initialText: string; onChange: (text: string) => void }) =>
    <textarea value={initialText} onInput={(event) => onChange(event.currentTarget.value)} onChange={() => {}} />,
}));

const original = '[general]\nlog_level = "info"\n';
const first = '[general]\nlog_level = "debug"\n';
const later = '[general]\nlog_level = "error"\n';
const initial = { revision: "r1", toml_projection: original, source_sections: ["general"], projection_kind: "normalized_config_api" };
const preview = { revision: "r1", patch: { general: { log_level: "debug" } }, patch_json: '{"general":{"log_level":"debug"}}', changed_paths: ["general.log_level"], materialized_sections: [], array_replacements: [] };
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const originalConfig = apiClient.getConfig();
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;

async function renderPanel() {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(getTelemtConfigTomlQueryKey(), initial);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={cache}><TomlSettingsPanel canRestartTelemt={false} /></QueryClientProvider>));
}
async function type(value: string) {
  await act(async () => {
    const input = document.querySelector("textarea")!; input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); cache?.clear(); apiClient.setConfig(originalConfig); vi.restoreAllMocks(); });

it("does not accept an old preview as validation for a later TOML draft (A03)", async () => {
  let validated = "", saved = "", finishPreview!: () => void;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "POST") {
      validated = (await req.json()).toml_projection;
      await new Promise<void>((resolve) => { finishPreview = resolve; });
      return Response.json(preview);
    }
    if (req.method === "PATCH") { saved = (await req.json()).toml_projection; return Response.json({ revision: "r2", changed: ["general.log_level"] }); }
    return Response.json(initial);
  } });
  await renderPanel(); await type(first);
  await act(async () => { button("Проверить").click(); await settle(); });
  await type(later);
  await act(async () => { finishPreview(); await settle(); });
  expect(validated).toBe(first);
  const save = button("Сохранить проверенное");
  expect(save.disabled).toBe(true);
  await act(async () => { save.click(); await settle(); });
  expect(saved).toBe("");
});

it("keeps dirty TOML input and focus after a newer server revision (A04)", async () => {
  await renderPanel(); await type(first);
  const input = document.querySelector("textarea")!; input.focus();
  await act(async () => { cache.setQueryData(getTelemtConfigTomlQueryKey(), { ...initial, revision: "r3", toml_projection: later }); await settle(); });
  expect(document.querySelector("textarea")!.value).toBe(first);
  expect(document.activeElement).toBe(input);
});

it("keeps revision-3 conflict after a delayed revision-2 save and late input", async () => {
  let finishSave!: () => void;
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "POST") return Response.json(preview);
    if (req.method === "PATCH") { await new Promise<void>((resolve) => { finishSave = resolve; }); return Response.json({ revision: "r2", changed: ["general.log_level"] }); }
    return Response.json({ ...initial, revision: "r3", toml_projection: later });
  } });
  await renderPanel(); await type(first);
  await act(async () => { button("Проверить").click(); await settle(); });
  await act(async () => { button("Сохранить проверенное").click(); await settle(); });
  const late = first + "# keep this edit\n"; await type(late);
  await act(async () => { cache.setQueryData(getTelemtConfigTomlQueryKey(), { ...initial, revision: "r3", toml_projection: later }); await settle(); finishSave(); await settle(); });
  expect(document.querySelector("textarea")!.value).toBe(late);
  expect(document.body.textContent).toContain("сервер");
});

it("preserves input after 409, copies the draft, and confirms discard to the server version", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "POST") return Response.json(preview);
    if (req.method === "PATCH") return Response.json({ code: "revision_conflict" }, { status: 409 });
    return Response.json({ ...initial, revision: "r3", toml_projection: later });
  } });
  await renderPanel(); await type(first);
  await act(async () => { button("Проверить").click(); await settle(); });
  await act(async () => { button("Сохранить проверенное").click(); await settle(); });
  expect(document.querySelector("textarea")!.value).toBe(first);
  expect(button("Оставить черновик")).toBeDefined();
  await act(async () => button("Скопировать TOML").click());
  expect(writeText).toHaveBeenCalledWith(first);
  await act(async () => button("Загрузить серверную версию").click());
  expect(document.querySelector("textarea")!.value).toBe(first);
  expect(document.body.textContent).toContain("Несохранённые изменения будут потеряны");
  await act(async () => button("Оставить черновик").click());
  expect(document.querySelector("textarea")!.value).toBe(first);
  await act(async () => button("Загрузить серверную версию").click());
  await act(async () => button("Загрузить серверную версию").click());
  expect(document.querySelector("textarea")!.value).toBe(later);
  expect(document.body.textContent).not.toContain("Настройки изменились на сервере");
});

it("keeps dirty TOML input mounted when a background GET fails", async () => {
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async () => { throw new Error("offline"); } });
  await renderPanel(); await type(first);
  const input = document.querySelector("textarea")!; input.focus();
  await act(async () => { await cache.refetchQueries({ queryKey: getTelemtConfigTomlQueryKey() }); await settle(); });
  expect(document.querySelector("textarea")?.value).toBe(first);
  expect(document.activeElement).toBe(input);
});

it("preserves revision-3 after the delayed save's canonical revision-2 GET", async () => {
  let finishSave!: () => void;
  let finishGet!: () => void;
  const canonical = first + "# canonical document\n";
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "POST") return Response.json(preview);
    if (req.method === "PATCH") { await new Promise<void>((resolve) => { finishSave = resolve; }); return Response.json({ revision: "r2", changed: ["general.log_level"] }); }
    await new Promise<void>((resolve) => { finishGet = resolve; });
    return Response.json({ ...initial, revision: "r2", toml_projection: canonical });
  } });
  await renderPanel(); await type(first);
  await act(async () => { button("Проверить").click(); await settle(); });
  await act(async () => { button("Сохранить проверенное").click(); await settle(); });
  const late = first + "# late input\n"; await type(late);
  await act(async () => { cache.setQueryData(getTelemtConfigTomlQueryKey(), { ...initial, revision: "r3", toml_projection: later }); await settle(); });
  await act(async () => { finishSave(); await settle(); });
  const input = document.querySelector("textarea")!; input.focus();
  await act(async () => { finishGet(); await settle(); });
  expect(document.querySelector("textarea")!.value).toBe(late);
  expect(document.activeElement).toBe(input);
  await act(async () => button("Загрузить серверную версию").click());
  await act(async () => button("Загрузить серверную версию").click());
  expect(document.querySelector("textarea")!.value).toBe(later);
});
