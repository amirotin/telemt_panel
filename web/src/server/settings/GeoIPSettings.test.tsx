import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocalePreference } from "../../i18n";
import { GeoIPSettings } from "./GeoIPSettings";
import { defaultGeoIPConfig } from "./geoip.helpers";
import type { GeoIpSettings } from "../../lib/api/generated/types.gen";

const api = vi.hoisted(() => ({ save: vi.fn(), update: vi.fn() }));
vi.mock("../../lib/api/generated/@tanstack/react-query.gen", () => ({
  getGeoIpSettingsOptions: () => ({ queryKey: ["geoip"], queryFn: vi.fn() }),
  getGeoIpSettingsQueryKey: () => ["geoip"],
  getUserIpHistoryQueryKey: () => ["ips"],
  putGeoIpSettingsMutation: () => ({ mutationFn: api.save }),
  updateGeoIpMutation: () => ({ mutationFn: api.update }),
}));
let root: Root | undefined;
let view: HTMLDivElement;
let client: QueryClient;
const empty = (): GeoIpSettings => ({ config: defaultGeoIPConfig(), status: { state: "disabled", available: false, active_source: null, databases: [], last_error: null } });
async function mount(data = empty()) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["geoip"], data);
  view = document.createElement("div"); document.body.append(view); root = createRoot(view);
  await act(async () => root!.render(<QueryClientProvider client={client}><GeoIPSettings /></QueryClientProvider>));
}
afterEach(() => { if (root) act(() => root!.unmount()); view?.remove(); client?.clear(); root = undefined; vi.clearAllMocks(); setLocalePreference("ru"); });
const click = async (selector: string) => { await act(async () => view.querySelector<HTMLInputElement>(selector)!.click()); };
const type = async (selector: string, value: string) => {
  await act(async () => {
    const input = view.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("GeoIPSettings", () => {
  it("does not download or save on mount and defaults to community Country + ASN", async () => {
    await mount();
    expect(api.save).not.toHaveBeenCalled(); expect(api.update).not.toHaveBeenCalled();
    expect(view.querySelector<HTMLInputElement>('[value="community"]')?.checked).toBe(true);
    expect(view.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(2);
    expect(view.textContent).not.toMatch(/Account ID|License Key/);
  });
  it("keeps active status unchanged while editing the source and hides the local-file schedule", async () => {
    const data = empty(); data.config.enabled = true;
    data.status = { ...data.status, state: "ready", available: true, active_source: "community" };
    await mount(data); await click('[value="files"]');
    expect(view.querySelector('[data-geoip-active-source]')?.textContent).toBe("P3TERX");
    expect(view.querySelector('[data-geoip-schedule]')).toBeNull();
    expect(view.querySelectorAll('input[type="text"]')).toHaveLength(2);
    expect(api.save).not.toHaveBeenCalled();
  });
  it("prevents submission without a selected database", async () => {
    await mount(); await click('[data-geoip-kind="country"]'); await click('[data-geoip-kind="asn"]');
    await click('button[type="submit"]');
    expect(view.querySelector('[role="alert"]')?.textContent).toContain("Выберите хотя бы одну");
    expect(api.save).not.toHaveBeenCalled();
  });
  it("connects only on explicit submission", async () => {
    const data = empty(); const result = { ...data, config: { ...data.config, enabled: true }, status: { ...data.status, state: "updating" } };
    api.save.mockResolvedValue(result);
    await mount(); await click('button[type="submit"]');
    expect(api.save).toHaveBeenCalledWith({ body: { ...data.config, enabled: true } }, expect.anything());
  });
  it.each([
    ["urls", "  https://example.org/my db.mmdb  "],
    ["files", "  /srv/geo/my db.mmdb  "],
  ] as const)("submits normalized %s locations while allowing pasted whitespace", async (source, location) => {
    await mount();
    await click(`[value="${source}"]`);
    await click('[data-geoip-kind="asn"]');
    await type('input[type="text"]', location);
    await click('button[type="submit"]');

    expect(api.save).toHaveBeenCalledWith({ body: expect.objectContaining({ enabled: true, source }) }, expect.anything());
    expect(api.save.mock.calls[0][0].body.country.location).toBe(location.trim());
  });
  it("shows retained databases and a retry after update failure", async () => {
    const data = empty(); data.config.enabled = true;
    data.status = { state: "error", available: true, active_source: "files", databases: [{ kind: "country", build_epoch_secs: 1700000000, loaded_epoch_secs: 1700001000 }], last_error: "download_failed" };
    await mount(data);
    expect(view.textContent).toContain("Предыдущие исправные базы продолжают работать");
    expect(view.querySelector('[data-geoip-update]')).not.toBeNull();
    expect(view.textContent).not.toContain("download_failed");
  });
  it.each([
    ["ru", "Подключённые геоданные доступны в истории IP пользователя.", "Страна и сеть"],
    ["en", "Connected geography data is available in user IP history.", "Country and network"],
  ] as const)("describes an ASN-only active set accurately in %s", async (locale, readyNote, unavailableKinds) => {
    setLocalePreference(locale);
    const data = empty();
    data.config = { ...data.config, enabled: true, country: { enabled: false, location: "" }, asn: { enabled: true, location: "" }, city: { enabled: false, location: "" } };
    data.status = { state: "ready", available: true, active_source: "community", databases: [{ kind: "asn", build_epoch_secs: 1700000000, loaded_epoch_secs: 1700001000 }], last_error: null };
    await mount(data);
    const status = view.querySelector(".geoip-status-card")!;
    expect(status.textContent).toContain(readyNote);
    expect(status.textContent).not.toContain(unavailableKinds);
    expect(status.textContent).toContain(locale === "ru" ? "Сеть / ASN" : "Network / ASN");
  });
  it("does not crash on an invalid database timestamp", async () => {
    const data = empty();
    data.status = { state: "ready", available: true, active_source: "files", databases: [{ kind: "country", build_epoch_secs: Number.MAX_SAFE_INTEGER, loaded_epoch_secs: 0 }], last_error: null };
    await mount(data);
    expect(view.querySelector(".geoip-db")?.textContent).toContain("—");
  });
});
