import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigPage } from "./ConfigPage";
import { client } from "../../lib/api/client";
import { getStrings } from "../../i18n";
import { getHostQueryKey, getTelemtConfigCatalogQueryKey, getTelemtConfigQueryKey, getTelemtConfigTomlQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";

vi.mock("../ServerShell", () => ({ ServerShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../useIsDesktop", () => ({ useIsDesktop: () => true }));
vi.mock("./TomlConfigEditor", () => ({ TomlConfigEditor: ({ initialText, onChange }: { initialText: string; onChange: (text: string) => void }) => <textarea value={initialText} onInput={(event) => onChange(event.currentTarget.value)} onChange={() => {}} /> }));
vi.mock("./StructuredSettingsForm", () => ({ StructuredSettingsForm: ({ sections, onChange }: { sections: { general: Record<string, string> }; onChange: (next: unknown) => void }) => <div>{["log_level", "ad_tag"].map((name) => <input key={name} aria-label={name} value={sections.general[name]} onChange={() => {}} onInput={(event) => onChange({ ...sections, general: { ...sections.general, [name]: event.currentTarget.value } })} />)}</div> }));

const copy = getStrings().server.config;
const original = '[general]\nlog_level = "info"\n';
const first = '[general]\nlog_level = "debug"\n';
const later = first + "# late draft\n";
const initial = { revision: "r1", sections: { general: { log_level: "info", ad_tag: "old" } } };
const tomlInitial = { revision: "r1", toml_projection: original, source_sections: ["general"], projection_kind: "normalized_config_api" };
const preview = { revision: "r1", patch: { general: { log_level: "debug" } }, patch_json: '{"general":{"log_level":"debug"}}', changed_paths: ["general.log_level"], materialized_sections: [], array_replacements: [] };
const previous = client.getConfig();
let root: Root | undefined;
let container: HTMLDivElement;
let cache: QueryClient;
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;
async function click(text: string) { await act(async () => { button(text).click(); await settle(); }); }
async function type(selector: string, value: string) { await act(async () => { const input = container.querySelector<HTMLInputElement>(selector)!; input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function render(fetch: (request: Request) => Promise<Response>) {
  client.setConfig({ baseUrl: "http://localhost", fetch: (request) => fetch(request as Request) });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  cache.setQueryData(getTelemtConfigQueryKey(), initial);
  cache.setQueryData(getTelemtConfigTomlQueryKey(), tomlInitial);
  cache.setQueryData(getHostQueryKey(), { caps: { restart_telemt: false } });
  cache.setQueryData(getTelemtConfigCatalogQueryKey(), { version: "3.5.14", fields: [], groups: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={cache}><ConfigPage /></QueryClientProvider>); await settle(); });
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; container?.remove(); cache?.clear(); client.setConfig(previous); });

it("keeps normal and advanced on the same structured draft and guards TOML until discard", async () => {
  await render(async () => Response.json(initial));
  await type('input[aria-label="log_level"]', "debug"); await click(copy.tabs.advanced);
  expect(container.querySelector<HTMLInputElement>('input[aria-label="log_level"]')?.value).toBe("debug");
  expect(button(copy.tabs.toml).disabled).toBe(true);
  await click(copy.tabs.normal);
  expect(container.querySelector<HTMLInputElement>('input[aria-label="log_level"]')?.value).toBe("debug");
});

it("retains a TOML draft across tabs and guards structured editing until explicit discard", async () => {
  await render(async () => Response.json(tomlInitial));
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.tabs.normal);
  expect(container.querySelector('input[aria-label="log_level"]')).toBeNull();
  await click(copy.tabs.toml);
  expect(container.querySelector("textarea")?.value).toBe(first);
  await click(copy.toml.loadRemote); await click(copy.toml.loadRemote); await click(copy.tabs.normal);
  expect(container.querySelector<HTMLInputElement>('input[aria-label="log_level"]')?.value).toBe("info");
});

it("keeps a late preview owned by the retained session and invalidates it for newer input", async () => {
  let finish!: () => void;
  await render(async (request) => { if (request.method === "POST") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json(preview); } return Response.json(tomlInitial); });
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.toml.validate);
  await click(copy.tabs.advanced);
  await act(async () => { finish(); await settle(); });
  await click(copy.tabs.toml);
  expect(button(copy.toml.saveValidated).disabled).toBe(false);
  await type("textarea", later);
  expect(button(copy.toml.saveValidated).disabled).toBe(true);
});

it("preserves late TOML input and the new baseline when PATCH finishes on another tab", async () => {
  let finish!: () => void;
  await render(async (request) => {
    if (request.method === "POST") return Response.json(preview);
    if (request.method === "PATCH") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ revision: "r2", changed: ["general.log_level"] }); }
    if (request.url.endsWith("/toml")) return Response.json({ ...tomlInitial, revision: "r2", toml_projection: first });
    return Response.json({ ...initial, revision: "r2", sections: { general: { log_level: "debug", ad_tag: "old" } } });
  });
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.toml.validate); await click(copy.toml.saveValidated); await type("textarea", later); await click(copy.tabs.normal);
  await act(async () => { finish(); await settle(); });
  await click(copy.tabs.toml);
  expect(container.querySelector("textarea")?.value).toBe(later);
  expect(button(copy.toml.saveValidated).disabled).toBe(true);
  expect(container.textContent).toContain("revision r2");
});

it.each(["revision_conflict", "telemt_config_outcome_unknown"])("retains the TOML draft and late %s outcome across tabs", async (code) => {
  let finish!: () => void;
  await render(async (request) => {
    if (request.method === "POST") return Response.json(preview);
    if (request.method === "PATCH") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ code }, { status: code === "revision_conflict" ? 409 : 504 }); }
    return Response.json({ ...tomlInitial, revision: "r2", toml_projection: '[general]\nlog_level = "error"\n' });
  });
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.toml.validate); await click(copy.toml.saveValidated); await click(copy.tabs.normal);
  await act(async () => { finish(); await settle(); });
  await click(copy.tabs.toml);
  expect(container.querySelector("textarea")?.value).toBe(first);
  if (code === "revision_conflict") expect(container.textContent).toContain(copy.toml.remoteChanged);
  else {
    expect(button(copy.checkWrite)).toBeDefined();
    expect(button(copy.toml.saveValidated).disabled).toBe(true);
  }
});

it.each(["discard", "revert"])("recovers a clean TOML session after %s during a delayed preview conflict", async (action) => {
  let finish!: () => void;
  const fresh = { ...tomlInitial, revision: "r2", toml_projection: '[general]\nlog_level = "error"\n' };
  await render(async (request) => {
    if (request.method === "POST") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ code: "revision_conflict" }, { status: 409 }); }
    return Response.json(fresh);
  });
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.toml.validate);
  if (action === "discard") { await click(copy.toml.loadRemote); await click(copy.toml.loadRemote); }
  else await type("textarea", original);
  await act(async () => { finish(); await settle(); });
  expect(container.querySelector("textarea")?.value).toBe(fresh.toml_projection);
  expect(container.textContent).toContain("revision r2");
  await click(copy.tabs.normal);
  expect(container.querySelector('input[aria-label="log_level"]')).not.toBeNull();
  expect(container.textContent).not.toContain(copy.structuredBlockedByToml);
});

it("allows the other tabs to discard a draft and cancel a pending validation", async () => {
  let finish!: () => void;
  await render(async (request) => {
    if (request.method === "POST") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ code: "revision_conflict" }, { status: 409 }); }
    return Response.json(tomlInitial);
  });
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.toml.validate); await click(copy.tabs.advanced);
  await click(copy.toml.loadRemote); await click(copy.toml.loadRemote);
  expect(container.querySelector('input[aria-label="log_level"]')).not.toBeNull();
  await act(async () => { finish(); await settle(); });
  expect(container.querySelector('input[aria-label="log_level"]')).not.toBeNull();
});

it("recovers a clean reverted TOML session after a delayed PATCH conflict on another tab", async () => {
  let finish!: () => void;
  const fresh = { ...tomlInitial, revision: "r2", toml_projection: '[general]\nlog_level = "error"\n' };
  await render(async (request) => {
    if (request.method === "POST") return Response.json(preview);
    if (request.method === "PATCH") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ code: "revision_conflict" }, { status: 409 }); }
    return Response.json(fresh);
  });
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.toml.validate); await click(copy.toml.saveValidated);
  await type("textarea", original);
  await act(async () => { cache.setQueryData(getTelemtConfigTomlQueryKey(), fresh); await settle(); });
  expect(container.querySelector("textarea")?.value).toBe(original);
  await click(copy.tabs.normal);
  await act(async () => { finish(); await settle(); });
  expect(cache.getQueryData(getTelemtConfigTomlQueryKey())).toMatchObject({ revision: "r2" });
  await click(copy.tabs.toml);
  expect(container.querySelector("textarea")?.value).toBe(fresh.toml_projection);
  await click(copy.tabs.normal);
  expect(container.querySelector('input[aria-label="log_level"]')).not.toBeNull();
});

it("keeps a late TOML revert after an unknown PATCH outcome and explicit server recovery", async () => {
  let finish!: () => void;
  const applied = { ...tomlInitial, revision: "r2", toml_projection: first };
  await render(async (request) => {
    if (request.method === "POST") return Response.json(preview);
    if (request.method === "PATCH") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ code: "telemt_config_outcome_unknown" }, { status: 504 }); }
    return Response.json(applied);
  });
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.toml.validate); await click(copy.toml.saveValidated); await type("textarea", original);
  await act(async () => { finish(); await settle(); });
  await click(copy.checkWrite);
  expect(container.querySelector("textarea")?.value).toBe(original);
  expect(container.textContent).toContain(copy.toml.remoteChanged);
  expect(button(copy.toml.saveValidated).disabled).toBe(true);
  await click(copy.toml.loadRemote); await click(copy.toml.loadRemote);
  expect(container.querySelector("textarea")?.value).toBe(first);
});

it("protects a late baseline revert from a background GET while PATCH is pending", async () => {
  let finish!: () => void;
  const applied = { ...tomlInitial, revision: "r2", toml_projection: first };
  await render(async (request) => {
    if (request.method === "POST") return Response.json(preview);
    if (request.method === "PATCH") { await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ code: "telemt_config_outcome_unknown" }, { status: 504 }); }
    return Response.json(applied);
  });
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.toml.validate); await click(copy.toml.saveValidated); await type("textarea", original);
  await act(async () => { cache.setQueryData(getTelemtConfigTomlQueryKey(), applied); await settle(); });
  expect(container.querySelector("textarea")?.value).toBe(original);
  await act(async () => { finish(); await settle(); });
  await click(copy.checkWrite);
  expect(container.querySelector("textarea")?.value).toBe(original);
  expect(container.textContent).toContain(copy.toml.remoteChanged);
});

it.each(["clean", "late", "hidden"])("retains the confirmed TOML revision before the follow-up GET for a %s session", async (variant) => {
  let finishSave!: () => void;
  let finishGet!: () => void;
  await render(async (request) => {
    if (request.method === "POST") return Response.json(preview);
    if (request.method === "PATCH") { await new Promise<void>((resolve) => { finishSave = resolve; }); return Response.json({ revision: "r2", changed: ["general.log_level"] }); }
    if (request.url.endsWith("/toml")) { await new Promise<void>((resolve) => { finishGet = resolve; }); return Response.json({ ...tomlInitial, revision: "r2", toml_projection: first }); }
    return Response.json({ ...initial, revision: "r2", sections: { general: { log_level: "debug", ad_tag: "old" } } });
  });
  await click(copy.tabs.toml); await type("textarea", first); await click(copy.toml.validate); await click(copy.toml.saveValidated);
  if (variant === "late") await type("textarea", later);
  if (variant === "hidden") await click(copy.tabs.normal);
  await act(async () => { finishSave(); await settle(); });
  if (variant === "hidden") await click(copy.tabs.toml);
  expect(container.querySelector("textarea")?.value).toBe(variant === "late" ? later : first);
  expect(container.textContent).toContain("revision r2");
  expect(container.textContent).not.toContain(copy.toml.remoteChanged);
  await act(async () => { finishGet(); await settle(); });
  expect(container.querySelector("textarea")?.value).toBe(variant === "late" ? later : first);
  expect(container.textContent).toContain("revision r2");
  expect(container.textContent).not.toContain(copy.toml.remoteChanged);
});

it("retries a structured conflict with the latest input and the fresh If-Match", async () => {
  const writes: { body: unknown; revision: string | null }[] = [];
  const fresh = { ...initial, revision: "r2", sections: { general: { log_level: "info", ad_tag: "remote" } } };
  await render(async (request) => {
    if (request.method === "PATCH") { writes.push({ body: await request.json(), revision: request.headers.get("If-Match") }); return writes.length === 1 ? Response.json({ code: "revision_conflict" }, { status: 409 }) : Response.json({ revision: "r3", changed: ["general.log_level"] }); }
    return Response.json(fresh);
  });
  await type('input[aria-label="log_level"]', "debug"); await click(copy.save); await click(copy.savePreview.apply.replace("{count}", "1"));
  await type('input[aria-label="log_level"]', "error"); await click(copy.conflictReload);
  expect(writes[1]).toEqual({ revision: "r2", body: { sections: { general: { log_level: "error" } } } });
});

it("shows an explicit overwrite choice when newer input introduces a server overlap", async () => {
  let writes = 0;
  const fresh = { ...initial, revision: "r2", sections: { general: { log_level: "info", ad_tag: "remote" } } };
  await render(async (request) => { if (request.method === "PATCH") { writes++; return Response.json({ code: "revision_conflict" }, { status: 409 }); } return Response.json(fresh); });
  await type('input[aria-label="log_level"]', "debug"); await click(copy.save); await click(copy.savePreview.apply.replace("{count}", "1"));
  await type('input[aria-label="ad_tag"]', "mine");
  expect(button(copy.conflictReload)).toBeUndefined();
  expect(button(copy.conflictReapplyMine)).toBeDefined();
  expect(container.textContent).toContain(copy.conflictOverlapWarning);
  expect(writes).toBe(1);
});
