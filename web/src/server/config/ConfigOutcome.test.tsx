import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { ConfigPage } from "./ConfigPage";
import { getStrings } from "../../i18n";
import { client } from "../../lib/api/client";
import { getHostQueryKey, getTelemtConfigCatalogQueryKey, getTelemtConfigQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";

vi.mock("../ServerShell", () => ({ ServerShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../useIsDesktop", () => ({ useIsDesktop: () => true }));

it.each(["envelope", "network", "html", "repeat"])("checks an unconfirmed structured %s failure without repeating it or losing the draft", async (failure) => {
  const initial = { revision: "r1", sections: { general: { log_level: "normal" } } };
  const fresh = { revision: "r2", sections: { general: { log_level: failure === "repeat" ? "normal" : "debug" } } };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: 1, retryDelay: 0 } } });
  const previous = client.getConfig();
  let writes = 0;
  client.setConfig({ baseUrl: "http://localhost", fetch: async (request) => {
    const req = request as Request;
    if (req.method === "PATCH") {
      writes++;
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "html") return new Response("gateway timeout", { status: 504, headers: { "Content-Type": "text/html" } });
      return Response.json({ code: "telemt_config_outcome_unknown" }, { status: 504 });
    }
    return Response.json(fresh);
  } });
  cache.setQueryData(getTelemtConfigQueryKey(), initial);
  cache.setQueryData(getHostQueryKey(), { caps: { restart_telemt: false } });
  cache.setQueryData(getTelemtConfigCatalogQueryKey(), {
    version: "3.5.14", source_commit: "test", documented_fields: 1, runtime_additions: [],
    groups: [{ id: "diagnostics", title: "Diagnostics", short: "Diagnostics" }],
    fields: [{ path: "general.log_level", kind: "enum", options: ["normal", "debug"], data_type: "LogLevel", group: "diagnostics", tier: "normal", default_value: "normal", doc_hot: false, apply: "runtime reload", secret: false }],
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  const copy = getStrings().server.config;
  const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  try {
    await act(async () => { root.render(<QueryClientProvider client={cache}><ConfigPage /></QueryClientProvider>); await settle(); });
    await act(async () => { const select = container.querySelector("select")!; select.value = "debug"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => button(copy.save)!.click());
    await act(async () => { button(copy.savePreview.apply.replace("{count}", "1"))!.click(); await settle(); });
    expect(writes).toBe(1);
    const check = button("Проверить серверную конфигурацию");
    expect(check).toBeDefined();
    await act(async () => { check!.click(); await settle(); });
    expect(writes).toBe(1);
    expect(container.querySelector("select")?.value).toBe("debug");
    if (failure === "repeat") {
      await act(async () => { button(copy.conflictReload)!.click(); await settle(); });
      expect(writes).toBe(2);
      expect(button(copy.save)!.disabled).toBe(false);
      await act(async () => { button("Проверить серверную конфигурацию")!.click(); await settle(); });
      expect(container.querySelector("select")?.value).toBe("debug");
      expect(writes).toBe(2);
    }
  } finally {
    act(() => root.unmount()); container.remove(); cache.clear(); client.setConfig(previous);
  }
});
