import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigPage } from "./ConfigPage";
import { client } from "../../lib/api/client";
import { getStrings } from "../../i18n";
import { getHostQueryKey, getTelemtInfoQueryKey, getTelemtConfigCatalogQueryKey, getTelemtConfigQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";

vi.mock("../ServerShell", () => ({ ServerShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../useIsDesktop", () => ({ useIsDesktop: () => true }));
vi.mock("./TomlConfigEditor", () => ({ TomlConfigEditor: ({ initialText, onChange }: { initialText: string; onChange: (text: string) => void }) => <textarea value={initialText} onInput={(event) => onChange(event.currentTarget.value)} onChange={() => {}} /> }));
vi.mock("./StructuredSettingsForm", () => ({ StructuredSettingsForm: ({ sections, onChange }: { sections: { general: Record<string, string> }; onChange: (next: unknown) => void }) => <input aria-label="log_level" value={sections.general["log_level"]} onChange={() => {}} onInput={(event) => onChange({ ...sections, general: { log_level: event.currentTarget.value } })} /> }));
const initial = { revision: "source-1", sections: { general: { log_level: "info" } } };
const native = { revision: "source-1", valid: true, base_revision: "source-1", candidate_revision: "candidate-2", runtime: { active_generation: 4, config_epoch: 7, runtime_match: "runtime-7" }, changed_paths: ["general.log_level"], normalization_effects: [{ path: "general.log_level", code: "normalized" }], apply: { watcher_paths: ["general.log_level"], generation_paths: [], process_restart_paths: [], runtime_reload_required: true, process_restart_required: false, deferred_process_fields: [] }, touched_sections: ["general"], warnings: [] };
const copy = getStrings().server.config;
const previous = client.getConfig();
let root: Root | undefined;
let container: HTMLDivElement;
let cache: QueryClient;
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;
async function click(text: string) { await act(async () => { button(text).click(); await settle(); }); }
async function edit(value = "debug") { await act(async () => { const input = container.querySelector<HTMLInputElement>("input")!; input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); await settle(); }); }
async function render(fetch: (request: Request) => Promise<Response>, readOnly = false, brokenConfig = false) {
  client.setConfig({ baseUrl: "http://localhost", fetch: (request) => {
    const req = request as Request;
    if (req.url.endsWith("/catalog")) return Promise.resolve(Response.json(cache.getQueryData(getTelemtConfigCatalogQueryKey())));
    if (req.url.endsWith("/info")) return Promise.resolve(Response.json({ version: "3.5.17", capabilities: { reload_api: true, read_only: readOnly, config_validation: false } }));
    return fetch(req);
  } });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  if (!brokenConfig) cache.setQueryData(getTelemtConfigQueryKey(), initial);
  cache.setQueryData(getTelemtInfoQueryKey(), { version: "3.5.17", capabilities: { reload_api: true, read_only: readOnly, config_validation: false } });
  cache.setQueryData(getHostQueryKey(), { caps: { restart_telemt: false } });
  cache.setQueryData(getTelemtConfigCatalogQueryKey(), { version: "3.5.17", fields: [], groups: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={cache}><ConfigPage /></QueryClientProvider>); await settle(); });
  await act(async () => { await settle(); });
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; container?.remove(); cache?.clear(); localStorage.clear(); client.setConfig(previous); });
const absent = () => Response.json({ code: "capability_absent" }, { status: 501 });
function optional(request: Request) { return /\/(state|schema|capabilities)$/.test(request.url) ? absent() : Response.json(initial); }

it("validates despite transient false flags and saves the exact native source/runtime tokens", async () => {
  let submitted: Request | undefined;
  let validations = 0;
  await render(async (request) => {
    if (request.url.includes("/validate")) { validations++; return Response.json(native); }
    if (request.method === "PATCH") { submitted = request; return Response.json({ revision: "source-2", changed: ["general.log_level"], runtime_reload_required: true }); }
    return optional(request);
  });
  await edit(); await click(copy.save);
  expect(validations).toBe(1);
  await click(copy.savePreview.apply.replace("{count}", "1"));
  expect(submitted?.headers.get("If-Match")).toBe("source-1");
  expect(submitted?.headers.get("If-Runtime-Match")).toBe("runtime-7");
  expect(await submitted?.json()).toEqual({ sections: { general: { log_level: "debug" } } });
  expect(container.textContent).not.toContain(copy.runtimeReloadNotice);
});

it.each(["capability_absent", "config_preflight_busy", "read_only"])("only falls back for explicit unsupported preflight: %s", async (code) => {
  let writes = 0;
  await render(async (request) => {
    if (request.url.includes("/validate")) return Response.json({ code, details: [{ path: "general.log_level", code: "invalid", message: "invalid level" }] }, { status: code === "capability_absent" ? 501 : 409 });
    if (request.method === "PATCH") { writes++; return Response.json({ revision: "r2", changed: [] }); }
    return optional(request);
  });
  await edit(); await click(copy.save);
  const apply = button(copy.savePreview.apply.replace("{count}", "1"));
  expect(apply.disabled).toBe(code !== "capability_absent");
  if (code !== "capability_absent") expect(document.body.textContent).toContain("general.log_level");
  else await click(copy.savePreview.apply.replace("{count}", "1"));
  expect(writes).toBe(code === "capability_absent" ? 1 : 0);
});

it("keeps a native state reload available when the saved source cannot be read", async () => {
  await render(async (request) => {
    if (request.url.endsWith("/state")) return Response.json({ revision: null, desired_revision: null, desired_status: "invalid", runtime: native.runtime, runtime_sample_current: true, effective: { general: { log_level: "info" } }, comparison: { status: "pending_publication", generation_pending_paths: ["access.user_source_deny"], truncated: false } });
    if (request.url.endsWith("/config")) return Response.json({ code: "telemt_config_read_failed" }, { status: 502 });
    return optional(request);
  }, false, true);
  expect(container.textContent).toContain("access.user_source_deny");
  expect(button(copy.reloadNow)).toBeDefined();
});

it("keeps preview usable while read-only prevents the write", async () => {
  let validations = 0;
  await render(async (request) => {
    if (request.url.includes("/validate")) { validations++; return Response.json(native); }
    return optional(request);
  }, true);
  await edit(); await click(copy.save);
  expect(validations).toBe(1);
  expect(button(copy.savePreview.apply.replace("{count}", "1")).disabled).toBe(true);
});

it("invalidates a late preflight after draft and reload-policy edits", async () => {
  let finish!: () => void;
  const requests: { body: unknown; reload: string | null }[] = [];
  await render(async (request) => {
    if (request.url.includes("/validate")) {
      requests.push({ body: await request.json(), reload: new URL(request.url).searchParams.get("reload") });
      if (requests.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
      return Response.json({ ...native, runtime: { ...native.runtime, runtime_match: `runtime-${requests.length}` } });
    }
    return optional(request);
  });
  await edit(); await click(copy.save);
  expect(button(copy.savePreview.apply.replace("{count}", "1")).disabled).toBe(true);
  await edit("error");
  await act(async () => { finish(); await settle(); });
  expect(requests[1]?.body).toEqual({ sections: { general: { log_level: "error" } } });
  await click(copy.reloadPolicy.instant);
  expect(requests.at(-1)?.reload).toBe("instant");
});

it("requires fresh validation after a runtime conflict and preserves the draft", async () => {
  let validations = 0;
  let writes = 0;
  await render(async (request) => {
    if (request.url.includes("/validate")) { validations++; return Response.json(native); }
    if (request.method === "PATCH") { writes++; return Response.json({ code: "runtime_conflict" }, { status: 409 }); }
    return optional(request);
  });
  await edit(); await click(copy.save); await click(copy.savePreview.apply.replace("{count}", "1"));
  expect(container.querySelector("input")?.value).toBe("debug");
  expect(writes).toBe(1);
  await click(copy.save);
  expect(validations).toBeGreaterThan(1);
});

it.each(["version", "capability"])("recovers state support across %s changes and hides stale data after support disappears", async (change) => {
  let supported = false;
  const state = { revision: "source-1", desired_revision: "source-1", desired_status: "valid", runtime: native.runtime, runtime_sample_current: true, comparison: { status: "pending_publication", generation_pending_paths: ["access.user_source_deny"], truncated: false } };
  await render(async (request) => request.url.endsWith("/state") ? supported ? Response.json(state) : absent() : optional(request));
  expect(container.textContent).not.toContain("access.user_source_deny");
  supported = true;
  await act(async () => { cache.setQueryData(getTelemtInfoQueryKey(), { version: change === "version" ? "3.5.18" : "3.5.17", capabilities: { reload_api: true, config_state: true } }); await settle(); });
  await act(async () => { await settle(); });
  expect(container.textContent).toContain("access.user_source_deny");
  supported = false;
  await click(copy.native.refresh);
  expect(container.textContent).not.toContain("access.user_source_deny");
});

it("shows native publication failures without exposing raw state", async () => {
  await render(async (request) => request.url.endsWith("/state") ? Response.json({ revision: null, desired_revision: null, desired_status: "unavailable", runtime: native.runtime, comparison: { status: "unknown" }, watcher: { phase: "failed", error_code: "config_parse_failed" }, reload: { error_present: true }, desired_error: { path: "$", code: "invalid", message: "Saved source is invalid" } }) : optional(request));
  expect(container.textContent).toContain("Saved source is invalid");
  expect(container.textContent).toContain(copy.native.publicationFailed);
  expect(container.textContent).toContain(copy.native.reloadFailed);
  expect(container.textContent).not.toContain('"phase"');
});

it.each([null, {}, { ...native, base_revision: undefined }, { ...native, base_revision: "older-source" }, { ...native, runtime: {} }, { ...native, runtime: { ...native.runtime, runtime_match: "" } }, { ...native, valid: false }, { ...native, revision: "different-source" }, { ...native, apply: {} }])("refuses malformed successful native validation: %j", async (payload) => {
  await render(async (request) => request.url.includes("/validate") ? Response.json(payload) : optional(request));
  await edit(); await click(copy.save);
  expect(button(copy.savePreview.apply.replace("{count}", "1")).disabled).toBe(true);
});

it("offers the existing rebase flow when native validation detects a source conflict", async () => {
  await render(async (request) => {
    if (request.url.includes("/validate")) return Response.json({ code: "revision_conflict" }, { status: 409 });
    if (request.url.endsWith("/config")) return Response.json({ revision: "source-2", sections: { general: { log_level: "info" }, network: { dns_overrides: [] } } });
    return optional(request);
  });
  await edit(); await click(copy.save);
  await act(async () => { await settle(); });
  expect(container.textContent).toContain(copy.conflictTitle);
  expect(container.querySelector("input")?.value).toBe("debug");
});

it("explains ignored null normalization before confirming a save", async () => {
  await render(async (request) => request.url.includes("/validate") ? Response.json({ ...native, normalization_effects: [{ path: "web.retry_jitter.peak_ms", code: "null_ignored" }] }) : optional(request));
  await edit(); await click(copy.save);
  expect(document.body.textContent).toContain("Пустое значение не изменит сохранённую настройку");
  expect(document.body.textContent).toContain("web.retry_jitter.peak_ms");
});

it.each(["policy", "edit", "revert", "version", "read-only", "source", "unchanged"])("checks current %s identity before submitting delayed rebase validation", async (change) => {
  let finish!: () => void;
  let writes = 0;
  const fresh = { ...initial, revision: "source-2" };
  await render(async (request) => {
    if (request.url.includes("/validate")) {
      const revision = request.headers.get("If-Match")!;
      if (revision === "source-2") await new Promise<void>((resolve) => { finish = resolve; });
      return Response.json({ ...native, revision, base_revision: revision });
    }
    if (request.method === "PATCH") { writes++; return Response.json({ code: "revision_conflict" }, { status: 409 }); }
    if (request.url.endsWith("/config")) return Response.json(fresh);
    return optional(request);
  });
  await edit(); await click(copy.reloadPolicy.instant); await click(copy.save);
  await click(copy.savePreview.apply.replace("{count}", "1"));
  await click(copy.conflictReload);
  expect(finish).toBeDefined();
  if (change === "policy") await click(copy.reloadPolicy.none);
  if (change === "edit" || change === "revert") await edit(change === "edit" ? "error" : "info");
  if (change === "version" || change === "read-only") await act(async () => {
    cache.setQueryData(getTelemtInfoQueryKey(), { version: change === "version" ? "3.5.18" : "3.5.17", capabilities: { reload_api: true, read_only: change === "read-only" } });
    await settle();
  });
  if (change === "source") await act(async () => { cache.setQueryData(getTelemtConfigQueryKey(), { ...fresh, revision: "source-3" }); await settle(); });
  await act(async () => { finish(); await settle(); });
  expect(writes).toBe(change === "unchanged" ? 2 : 1);
  expect(container.querySelector("input")?.value).toBe(change === "edit" ? "error" : change === "revert" ? "info" : "debug");
});

const completeState = (revision: string) => ({ revision, desired_revision: revision, desired_status: "valid", runtime: native.runtime, runtime_sample_current: true, sections: ["general", "network", "server", "timeouts", "censorship", "upstreams", "dc_overrides", "web", "access", "logging", "root"], comparison: { status: "published_match", truncated: false, pending_paths: [], watcher_pending_paths: [], generation_pending_paths: [], process_deferred_paths: [] } });

it.each(["current", "stale", "partial", "legacy", "other-revision"])("reconciles the TOML reload notice only with fresh full matching publication: %s", async (stateKind) => {
  const original = '[server.api]\nruntime_edge_enabled = false\n';
  const updated = '[server.api]\nruntime_edge_enabled = true\n';
  const path = "server.api.runtime_edge_enabled";
  let saved = false;
  let reloaded = false;
  await render(async (request) => {
    if (request.url.endsWith("/state")) {
      if (reloaded && stateKind === "legacy") return absent();
      const state = completeState(saved ? "source-2" : "source-1");
      if (!reloaded) return Response.json({ ...state, comparison: { ...state.comparison, status: "pending_publication", pending_paths: [path], generation_pending_paths: [path] } });
      return Response.json({ ...state, ...(stateKind === "stale" ? { runtime_sample_current: false } : {}), ...(stateKind === "partial" ? { sections: ["server"] } : {}), ...(stateKind === "other-revision" ? { revision: "source-1", desired_revision: "source-1" } : {}) });
    }
    if (request.url.includes("/toml/preview")) return Response.json({ revision: "source-1", patch: { server: { api: { runtime_edge_enabled: true } } }, patch_json: '{"server":{"api":{"runtime_edge_enabled":true}}}', changed_paths: [path], materialized_sections: [], array_replacements: [], runtime_match: "runtime-7", validation: { ...native, changed_paths: [path], normalization_effects: [], apply: { ...native.apply, watcher_paths: [], generation_paths: [path] } } });
    if (request.method === "PATCH") { saved = true; return Response.json({ revision: "source-2", changed: [path], runtime_reload_required: true }); }
    if (request.url.endsWith("/reload") && request.method === "POST") { reloaded = true; return Response.json({ reload_id: 1 }); }
    if (request.url.endsWith("/reload/1")) return Response.json({ reload_id: 1, state: "succeeded" });
    if (request.url.endsWith("/toml")) return Response.json({ revision: saved ? "source-2" : "source-1", toml_projection: saved ? updated : original, source_sections: ["server"], projection_kind: "normalized_config_api" });
    if (request.url.endsWith("/config")) return Response.json({ ...initial, revision: saved ? "source-2" : "source-1" });
    return optional(request);
  });
  await click(copy.tabs.toml);
  await act(async () => { const input = container.querySelector<HTMLTextAreaElement>("textarea")!; input.value = updated; input.dispatchEvent(new Event("input", { bubbles: true })); await settle(); });
  await click(copy.toml.validate); await click(copy.toml.saveValidated);
  const panel = () => container.querySelector('[data-testid="toml-settings-panel"]')!;
  expect(panel().textContent).toContain(copy.runtimeReloadNotice);
  await act(async () => { [...panel().querySelectorAll("button")].find((item) => item.textContent === copy.reloadNow)!.click(); await settle(); });
  await act(async () => { await settle(); });
  expect(reloaded).toBe(true);
  if (stateKind === "current") expect(panel().textContent).not.toContain(copy.runtimeReloadNotice);
  else expect(panel().textContent).toContain(copy.runtimeReloadNotice);
});
