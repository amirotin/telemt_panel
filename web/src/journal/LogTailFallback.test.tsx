import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { client } from "../lib/api/generated/client.gen";
import { DisplayModeProvider } from "../display-mode";
import { ru } from "../i18n/testing";
import { LogTailFallback } from "./LogTailFallback";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const previousConfig = client.getConfig();
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container?.remove();
  client.setConfig(previousConfig);
});

describe("Journal tail errors", () => {
  it("shows the source and configured target after a failed tail request", async () => {
    client.setConfig({ baseUrl: "http://localhost", fetch: async () => new Response(JSON.stringify({
      code: "log_source_error", message: "safe", source: "journald", service: "telemt",
      target: "telemt-custom.service", reason: "permission_denied", exit_code: 1,
    }), { status: 502, headers: { "Content-Type": "application/json" } }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<QueryClientProvider client={queryClient}><DisplayModeProvider><LogTailFallback service="telemt" onServiceChange={() => {}} /></DisplayModeProvider></QueryClientProvider>));
    const load = [...container.querySelectorAll("button")].find(button => button.textContent === ru.journal.tailFallback.loadButton);
    await act(async () => { load!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    const error = container.querySelector('[role="alert"]');
    expect(error?.textContent).toContain("telemt-custom.service");
    expect(error?.textContent).toContain("journald");
    expect(container.textContent).not.toContain(ru.journal.emptyTitle);
    queryClient.clear();
  });
});
