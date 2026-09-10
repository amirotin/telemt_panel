import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelTlsPrepared, PanelTlsSettings } from "../../lib/api/generated/types.gen";
import { setLocalePreference } from "../../i18n";
import { PanelAccessForm } from "./PanelAccessForm";

const api = vi.hoisted(() => ({ prepare: vi.fn(), save: vi.fn(), restart: vi.fn(), load: vi.fn() }));
vi.mock("../../lib/api/generated/@tanstack/react-query.gen", () => ({
  getPanelTlsConfigOptions: () => ({ queryKey: ["panel-tls-config"], queryFn: api.load }),
  getPanelTlsConfigQueryKey: () => ["panel-tls-config"],
  getPanelTlsQueryKey: () => ["panel-tls"],
  preparePanelTlsMutation: () => ({ mutationFn: api.prepare }),
  putPanelTlsConfigMutation: () => ({ mutationFn: api.save }),
  restartPanelTlsMutation: () => ({ mutationFn: api.restart }),
}));

const editable = (): PanelTlsSettings => ({
  active: { listen: "0.0.0.0:8080", tls: { mode: "http" } },
  configured: { listen: "0.0.0.0:8080", tls: { mode: "http" } },
  capabilities: { config_writable: true, restart: true, prepare: true, acme_prepare: true },
  manual_hints: [],
  default_acme_cache_dir: "/etc/telemt-panel/certs",
  config_path: "/etc/telemt-panel/config.toml",
  manual_restart_command: "systemctl restart telemt-panel",
  state: "idle",
  restart_required: false,
});

const prepared = (overrides: Partial<PanelTlsPrepared> = {}): PanelTlsPrepared => ({
  receipt: "receipt-123",
  expires_at: "2026-09-10T12:05:00Z",
  candidate: {
    listen: "0.0.0.0:8443",
    tls: { mode: "acme", acme_domain: "panel.example.com", acme_cache_dir: "/etc/telemt-panel/certs" },
  },
  new_url: "https://panel.example.com:8443",
  warnings: ["toml_formatting", "public_reachability_unverified", "password_login", "firewall_port", "acme_port_80"],
  certificate: { domain: "panel.example.com", expires_at: "2026-12-09T12:00:00Z", publicly_trusted: true },
  ...overrides,
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let client: QueryClient | undefined;

async function mount(data = editable(), seed = true) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  if (seed) client.setQueryData(["panel-tls-config"], data);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <QueryClientProvider client={client!}><PanelAccessForm onClose={vi.fn()} /></QueryClientProvider>,
  ));
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

function input(label: string) {
  const fieldLabel = [...document.querySelectorAll("label")].find((node) => node.textContent?.includes(label));
  return fieldLabel?.querySelector<HTMLInputElement>("input") ?? null;
}

function button(label: string) {
  return [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
}

async function click(element: HTMLElement | undefined | null) {
  expect(element).not.toBeNull();
  await act(async () => { element!.click(); });
}

async function type(field: HTMLInputElement | null, value: string) {
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  client?.clear();
  root = undefined;
  host = undefined;
  client = undefined;
  vi.clearAllMocks();
  setLocalePreference("ru");
});

describe("PanelAccessForm", () => {
  it("shows a failed initial load instead of an endless skeleton", async () => {
    api.load.mockRejectedValue(new Error("offline"));
    const dialog = await mount(editable(), false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Не удалось получить состояние HTTPS");
  });

  it("locks the checked inputs and aborts preparation when the form closes", async () => {
    let release!: (value: PanelTlsPrepared) => void;
    api.prepare.mockImplementation(() => new Promise<PanelTlsPrepared>((resolve) => { release = resolve; }));
    await mount();
    await click(input("Автоматический HTTPS"));
    await type(input("Домен"), "panel.example.com");
    await click(button("Получить сертификат и проверить"));
    expect(input("Домен")?.matches(":disabled")).toBe(true);
    const signal = api.prepare.mock.calls[0][0].signal as AbortSignal;
    expect(signal).toBeDefined();
    await act(async () => root!.unmount());
    root = undefined;
    expect(signal.aborted).toBe(true);
    await act(async () => release(prepared()));
  });

  it("reports a known restart rejection rather than suggesting a lost acknowledgement", async () => {
    api.restart.mockRejectedValue({ code: "tls_restart_not_pending", message: "configuration no longer pending" });
    const dialog = await mount({ ...editable(), state: "saved", restart_required: true, new_url: prepared().new_url });
    await click(button("Перезапустить панель"));
    await settle();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("configuration no longer pending");
    expect(dialog.textContent).not.toContain("Старый адрес мог отключиться");
  });
  it("requires mode-dependent certificate and ACME fields", async () => {
    const dialog = await mount();
    await click(input("Готовый сертификат"));
    expect(input("Путь к сертификату")).not.toBeNull();
    expect(input("Путь к приватному ключу")).not.toBeNull();
    await click(button("Проверить настройки"));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Укажите пути");
    expect(api.prepare).not.toHaveBeenCalled();

    await click(input("Автоматический HTTPS"));
    expect(input("Домен")).not.toBeNull();
    expect(dialog.textContent).toContain("Let's Encrypt");
    await click(button("Получить сертификат и проверить"));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Укажите домен");
  });

  it("requires explicit confirmation and sends exact ordinary HTTP payload", async () => {
    const dialog = await mount();
    expect(input("Я понимаю, что соединение не зашифровано")).not.toBeNull();
    await click(button("Проверить настройки"));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("подтвердите HTTP");
    expect(api.prepare).not.toHaveBeenCalled();

    api.prepare.mockResolvedValue(prepared({
      candidate: { listen: "0.0.0.0:8080", tls: { mode: "http" } },
      new_url: "http://panel.example.com:8080",
      warnings: ["http_unencrypted"],
      certificate: undefined,
    }));
    await click(input("Я понимаю, что соединение не зашифровано"));
    await click(button("Проверить настройки"));
    await settle();
    expect(api.prepare).toHaveBeenCalledWith({
      body: { base_path: "", public_url: "", enabled: false, listen: "0.0.0.0:8080", tls: { mode: "http" }, confirm_http: true },
      signal: expect.any(AbortSignal),
    }, expect.anything());
  });

  it("requires HTTP confirmation when a proxy listener is changed to a public bind", async () => {
    api.prepare.mockResolvedValue(prepared({
      candidate: { listen: "0.0.0.0:8080", tls: { mode: "http" } },
      new_url: "http://0.0.0.0:8080",
      warnings: ["http_unencrypted"],
      certificate: undefined,
    }));
    const dialog = await mount();
    await click(input("HTTPS через reverse proxy"));
    await type(input("Адрес прослушивания"), "0.0.0.0");
    expect(input("Я понимаю, что соединение не зашифровано")).not.toBeNull();
    await click(button("Проверить настройки"));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("подтвердите HTTP");
    expect(api.prepare).not.toHaveBeenCalled();

    await click(input("Я понимаю, что соединение не зашифровано"));
    await click(button("Проверить настройки"));
    await settle();
    expect(api.prepare).toHaveBeenCalledWith({
      body: { base_path: "", public_url: "", enabled: false, listen: "0.0.0.0:8080", tls: { mode: "http" }, confirm_http: true },
      signal: expect.any(AbortSignal),
    }, expect.anything());
  });

  it("shows provider firewall guidance as soon as the port changes", async () => {
    const dialog = await mount();
    await type(input("Порт"), "9443");
    expect(dialog.textContent).toMatch(/открыть TCP-порт 9443/i);
    expect(dialog.querySelectorAll("[data-network-warnings]")).toHaveLength(1);
  });

  it("renders useful manual steps when write or restart capability is missing", async () => {
    const data = editable();
    data.capabilities = { config_writable: false, restart: false, prepare: false, acme_prepare: false };
    data.manual_hints = ["edit_startup_config_manually", "restart_panel_manually"];
    const dialog = await mount(data);
    expect(dialog.textContent).toContain("/etc/telemt-panel/config.toml");
    expect(dialog.textContent).toContain("systemctl restart telemt-panel");
    expect(dialog.textContent).toContain("Измените конфигурацию вручную");
    expect(button("Проверить настройки")).toBeUndefined();
  });

  it("keeps form input and shows localized summary plus technical cause after prepare failure", async () => {
    api.prepare.mockRejectedValue({ code: "tls_listener_unavailable", message: "listen tcp 0.0.0.0:9443: bind: address already in use" });
    const dialog = await mount();
    await click(input("Автоматический HTTPS"));
    await type(input("Домен"), "panel.example.com");
    await type(input("Порт"), "9443");
    await click(button("Получить сертификат и проверить"));
    await settle();
    expect(dialog.textContent).toContain("Не удалось открыть новый адрес");
    expect(dialog.textContent).toContain("address already in use");
    expect(input("Домен")?.value).toBe("panel.example.com");
    expect(input("Порт")?.value).toBe("9443");
  });

  it("invalidates a successful preparation when any field changes", async () => {
    api.prepare.mockResolvedValue(prepared());
    const dialog = await mount();
    await click(input("Автоматический HTTPS"));
    await type(input("Домен"), "panel.example.com");
    await type(input("Порт"), "8443");
    await click(button("Получить сертификат и проверить"));
    await settle();
    expect(dialog.textContent).toContain("https://panel.example.com:8443");
    expect(dialog.textContent?.match(/\.bak/g)).toHaveLength(1);
    expect(dialog.textContent).toContain("Сертификат проверен");
    expect(dialog.textContent).toContain("panel.example.com");
    expect(dialog.querySelector('time[datetime="2026-12-09T12:00:00Z"]')).not.toBeNull();
    expect(dialog.textContent).toContain("Публичное доверие подтверждено");
    expect(button("Сохранить настройки")).toBeDefined();
    expect(button("Получить сертификат и проверить")).toBeUndefined();
    expect(button("Изменить параметры")).toBeDefined();
    await click(button("Изменить параметры"));
    await type(input("Порт"), "9443");
    expect(button("Сохранить настройки")).toBeUndefined();
    expect(button("Получить сертификат и проверить")).toBeDefined();
  });

  it("saves the normalized candidate returned by prepare and keeps active status separate", async () => {
    const result = prepared();
    api.prepare.mockResolvedValue(result);
    api.save.mockResolvedValue({ new_url: result.new_url, restart_required: true });
    const dialog = await mount();
    await click(input("Автоматический HTTPS"));
    await type(input("Домен"), "panel.example.com");
    await type(input("Порт"), "8443");
    await click(button("Получить сертификат и проверить"));
    await settle();
    await click(button("Сохранить настройки"));
    await settle();
    expect(api.save).toHaveBeenCalledWith({ body: { receipt: "receipt-123", candidate: result.candidate } }, expect.anything());
    expect(dialog.textContent).toContain("Настройки сохранены и ожидают перезапуска");
    expect(dialog.textContent).toContain("Перед следующим управляемым изменением перезапустите панель");
    expect([...dialog.querySelectorAll("h3")].filter((heading) => heading.textContent === "Настройки сохранены и ожидают перезапуска")).toHaveLength(1);
    expect(button("Получить сертификат и проверить")).toBeUndefined();
    expect(dialog.textContent).toContain("Сейчас работает: Обычный HTTP");
    expect(dialog.textContent).not.toContain("HTTPS уже работает");
    expect(dialog.querySelector('a[href="https://panel.example.com:8443/"]')).not.toBeNull();
  });

  it("does not call an accepted restart a save failure when the old origin disconnects", async () => {
    const result = prepared();
    api.prepare.mockResolvedValue(result);
    api.save.mockResolvedValue({ new_url: result.new_url, restart_required: true });
    api.restart.mockRejectedValue(new TypeError("Failed to fetch"));
    const dialog = await mount();
    await click(input("Автоматический HTTPS"));
    await type(input("Домен"), "panel.example.com");
    await type(input("Порт"), "8443");
    await click(button("Получить сертификат и проверить"));
    await settle();
    await click(button("Сохранить настройки"));
    await settle();
    await click(button("Перезапустить панель"));
    await settle();
    expect(dialog.textContent).toContain("Старый адрес мог отключиться после принятого запроса");
    expect(dialog.textContent).not.toContain("Не удалось сохранить");
    expect(dialog.querySelector('a[href="https://panel.example.com:8443/"]')).not.toBeNull();
  });

  it("labels a 202 response as restart requested without claiming HTTPS is active", async () => {
    const result = prepared();
    api.prepare.mockResolvedValue(result);
    api.save.mockResolvedValue({ new_url: result.new_url, restart_required: true });
    api.restart.mockResolvedValue({ new_url: result.new_url, restart_required: true });
    const dialog = await mount();
    await click(input("Автоматический HTTPS"));
    await type(input("Домен"), "panel.example.com");
    await type(input("Порт"), "8443");
    await click(button("Получить сертификат и проверить"));
    await settle();
    await click(button("Сохранить настройки"));
    await settle();
    await click(button("Перезапустить панель"));
    await settle();
    expect(dialog.textContent).toContain("Перезапуск запрошен");
    expect(dialog.textContent).toContain("проверить новый адрес");
    expect(button("Перезапустить панель")).toBeUndefined();
    expect(dialog.textContent).not.toContain("HTTPS уже работает");
    await act(async () => client!.setQueryData(["panel-tls-config"], {
      ...editable(), configured: result.candidate, state: "restart_failed", error: "tls_restart_failed",
      restart_required: true, new_url: result.new_url,
    }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(button("Перезапустить панель")).toBeDefined();
    await act(async () => client!.setQueryData(["panel-tls-config"], {
      ...editable(), active: result.candidate, configured: result.candidate,
    }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(dialog.textContent).not.toContain("Настройки сохранены и ожидают перезапуска");
    expect(button("Сохранить настройки")).toBeUndefined();
  });
});
