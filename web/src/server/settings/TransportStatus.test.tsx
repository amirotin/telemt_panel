import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportStatus } from "./TransportStatus";
import { ru } from "../../i18n/testing";
import type { PanelTlsSettings } from "../../lib/api/generated/types.gen";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(), useQuery: query,
}));

afterEach(() => { query.mockReset(); });

const editableSettings: PanelTlsSettings = {
  active: { listen: "0.0.0.0:8080", tls: { mode: "http" } },
  configured: { listen: "0.0.0.0:8080", tls: { mode: "http" } },
  capabilities: { config_writable: true, restart: true, prepare: true, acme_prepare: true },
  manual_hints: [],
  default_acme_cache_dir: "/etc/telemt-panel/certs",
  manual_restart_command: "systemctl restart telemt-panel",
  state: "idle",
  restart_required: false,
};

async function renderTransport(settings = editableSettings) {
  query.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
    const key = JSON.stringify(options.queryKey);
    if (key.includes("getPanelTlsConfig")) return { data: settings, isError: false, isPending: false };
    return { data: { mode: "http", state: "http" }, isError: false, isPending: false };
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><TransportStatus /></QueryClientProvider>); });
  return { container, root };
}

async function unmount(root: Root, container: HTMLElement) {
  await act(async () => { root.unmount(); });
  container.remove();
}

async function textFor(data: object | undefined, isError = false) {
  query.mockReturnValue({ data, isError, isPending: false });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<TransportStatus />); });
    return container.textContent;
  } finally { await act(async () => { root.unmount(); }); }
}

describe("panel transport", () => {
  it("opens a form with four readable access modes", async () => {
    const { container, root } = await renderTransport();
    try {
      const configure = [...container.querySelectorAll("button")].find((button) => button.textContent === "Настроить");
      expect(configure).toBeDefined();
      await act(async () => { configure!.click(); });
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Автоматический HTTPS");
      expect(dialog.textContent).toContain("Готовый сертификат");
      expect(dialog.textContent).toContain("HTTPS через reverse proxy");
      expect(dialog.textContent).toContain("Обычный HTTP");
    } finally {
      await unmount(root, container);
    }
  });

  it("keeps a saved configuration pending and separate from the active HTTP transport", async () => {
    const { container, root } = await renderTransport({
      ...editableSettings,
      configured: { listen: "0.0.0.0:8443", tls: { mode: "acme", acme_domain: "panel.example.com" } },
      state: "saved",
      restart_required: true,
      new_url: "https://panel.example.com:8443",
    });
    try {
      expect(container.textContent).toContain("Ожидает перезапуска");
      expect(container.textContent).toContain("Сейчас работает");
      expect(container.textContent).toContain("Без HTTPS");
      expect(container.textContent).not.toContain("HTTPS уже работает");
    } finally {
      await unmount(root, container);
    }
  });

  it("keeps explicit HTTP and explains its limitations", async () => {
    const text = await textFor({ mode: "http", state: "http" });
    expect(text).toContain(ru.server.settings.transport.modes.http);
    expect(text).toContain(ru.server.settings.transport.httpWarning);
    expect(text).not.toContain(ru.server.settings.transport.waiting);
  });
  it("shows the ACME domain and certificate expiration", async () => {
    const text = await textFor({ mode: "acme", state: "ready", domain: "panel.example.com", expires_at: "2026-12-01T12:00:00Z" });
    expect(text).toContain("panel.example.com");
    expect(text).toContain(ru.server.settings.transport.expires);
    expect(text).not.toContain(ru.server.settings.transport.httpWarning);
  });
  it("does not label pending issuance as ready", async () => {
    const text = await textFor({ mode: "acme", state: "waiting", domain: "panel.example.com" });
    expect(text).toContain(ru.server.settings.transport.waiting);
    expect(text).not.toContain(ru.server.settings.transport.expires);
  });
  it("shows renewal errors while keeping certificate metadata", async () => {
    const text = await textFor({ mode: "acme", state: "warning", stage: "ca_response", error: "HTTP 429", expires_at: "2026-12-01T12:00:00Z" });
    expect(text).toContain("HTTP 429");
    expect(text).toContain(ru.server.settings.transport.warning);
    expect(text).toContain(ru.server.settings.transport.expires);
  });
  it("does not invent HTTPS state after an API failure", async () => {
    expect(await textFor(undefined, true)).toContain(ru.server.settings.transport.unavailable);
  });
});
