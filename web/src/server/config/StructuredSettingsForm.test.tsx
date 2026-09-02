import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemtConfigCatalog, TelemtConfigField } from "../../lib/api/generated/types.gen";
import { getStrings } from "../../i18n";
import { StructuredSettingsForm } from "./StructuredSettingsForm";

function field(path: string, kind: TelemtConfigField["kind"], group: string, dataType = "String"): TelemtConfigField {
  return {
    path,
    kind,
    group,
    data_type: dataType,
    default_value: "—",
    doc_hot: false,
    apply: "runtime reload",
    tier: "normal",
    secret: path.endsWith("password"),
    ...(kind === "enum" ? { options: ["direct", "socks5", "shadowsocks"] } : {}),
  };
}

function catalog(group: "routing" | "me" | "upstreams" | "tls" | "listeners" | "web", fields: TelemtConfigField[]): TelemtConfigCatalog {
  return {
    version: "3.5.5",
    source_commit: "test",
    documented_fields: fields.length,
    runtime_additions: [],
    groups: [{ id: group, title: group === "routing" ? "Режимы и маршрутизация" : group === "me" ? "ME и NAT" : group === "upstreams" ? "Upstreams и дата-центры" : group === "tls" ? "TLS и маскировка" : group === "web" ? "WEB transport" : "Слушатели", short: group }],
    fields,
  };
}

describe("StructuredSettingsForm record editors", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not introduce a second main landmark inside the page shell", () => {
    const fields = [field("general.fast_mode", "boolean", "routing", "bool")];
    act(() => root.render(<StructuredSettingsForm catalog={catalog("routing", fields)} sections={{ general: { fast_mode: false } }} mode="normal" onChange={() => {}} />));

    expect(container.querySelector("main")).toBeNull();
    expect(container.querySelector("section")).not.toBeNull();
  });

  it("keeps multiple upstreams as bounded collapsible records and duplicates the whole record", () => {
    const fields = [
      field("upstreams[].type", "enum", "upstreams", '"direct" or "socks5"'),
      field("upstreams[].enabled", "boolean", "upstreams", "bool"),
      field("upstreams[].weight", "integer", "upstreams", "u16"),
      field("upstreams[].scopes", "string", "upstreams"),
    ];
    const sections = {
      upstreams: [
        { type: "direct", enabled: true, weight: 1, scopes: "" },
        { type: "socks5", enabled: true, weight: 2, scopes: "dc2", address: "127.0.0.1:1080" },
      ],
    };
    const onChange = vi.fn();
    act(() => root.render(<StructuredSettingsForm catalog={catalog("upstreams", fields)} sections={sections} mode="normal" onChange={onChange} />));

    const s = getStrings().server.config.catalog;
    const duplicates = [...container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${s.duplicateRecord}"]`)];
    const expanders = [...container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${s.expandRecord}"]`)];
    expect(duplicates).toHaveLength(2);
    expect(expanders).toHaveLength(1);
    expect(container.querySelectorAll(`button[aria-label="${s.collapseRecord}"]`)).toHaveLength(1);

    act(() => duplicates[1].click());
    const next = onChange.mock.calls[0][0] as typeof sections;
    expect(next.upstreams).toHaveLength(3);
    expect(next.upstreams[2]).toEqual(sections.upstreams[1]);
    expect(next.upstreams[2]).not.toBe(sections.upstreams[1]);
  });

  it("can create the first upstream when the optional section is absent", () => {
    const fields = [
      field("upstreams[].type", "enum", "upstreams", '"direct" or "socks5"'),
      field("upstreams[].enabled", "boolean", "upstreams", "bool"),
    ];
    const onChange = vi.fn();
    act(() => root.render(<StructuredSettingsForm catalog={catalog("upstreams", fields)} sections={{}} mode="normal" onChange={onChange} />));

    const s = getStrings().server.config.catalog;
    const add = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes(s.addUpstream));
    expect(add).toBeTruthy();
    act(() => add?.click());
    expect(onChange.mock.calls[0][0].upstreams).toEqual([
      { enabled: true, scopes: "", type: "direct", weight: 1 },
    ]);
  });

  it("renders TLS domains and per-SNI masks as separate records instead of JSON", () => {
    const fields = [
      field("censorship.tls_domains", "string_list", "tls", "String[]"),
      field("censorship.exclusive_mask", "map", "tls", "Map<String, String>"),
    ];
    const sections = {
      censorship: {
        tls_domains: ["one.example", "two.example", "three.example"],
        exclusive_mask: {
          "one.example": "127.0.0.1:443",
          "two.example": "127.0.0.1:8443",
          "three.example": "[::1]:443",
        },
      },
    };
    act(() => root.render(<StructuredSettingsForm catalog={catalog("tls", fields)} sections={sections} mode="normal" onChange={() => {}} />));

    const s = getStrings().server.config.catalog;
    expect(container.querySelectorAll(`input[aria-label^="${s.tlsDomain} "]`)).toHaveLength(3);
    expect(container.querySelectorAll(`input[aria-label^="${s.sniDomain} "]`)).toHaveLength(3);
    expect(container.querySelectorAll(`input[aria-label^="${s.maskTarget} "]`)).toHaveLength(3);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("renders routing semantics as multi-mode selection plus a primary route", () => {
    const fields = [
      field("general.modes.classic", "boolean", "routing", "bool"),
      field("general.modes.secure", "boolean", "routing", "bool"),
      field("general.modes.tls", "boolean", "routing", "bool"),
      field("general.use_middle_proxy", "boolean", "routing", "bool"),
      field("general.me2dc_fallback", "boolean", "routing", "bool"),
      field("general.fast_mode", "boolean", "routing", "bool"),
    ];
    const sections = {
      general: {
        modes: { classic: false, secure: false, tls: true },
        use_middle_proxy: false,
        me2dc_fallback: true,
        fast_mode: true,
      },
    };
    const onChange = vi.fn();
    act(() => root.render(<StructuredSettingsForm catalog={catalog("routing", fields)} sections={sections} mode="normal" onChange={onChange} />));

    const s = getStrings().server.config.catalog;
    const tlsButton = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')]
      .find((button) => button.textContent?.includes(s.labels["general.modes.tls"]));
    expect(tlsButton).toBeTruthy();
    act(() => tlsButton?.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain(s.clientModeRequired);

    const classicButton = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="false"]')]
      .find((button) => button.textContent?.includes(s.labels["general.modes.classic"]));
    act(() => classicButton?.click());
    expect(onChange.mock.calls[0][0].general.modes.classic).toBe(true);

    const directChoice = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
      .find((button) => button.textContent?.includes(s.routeDirect));
    expect(directChoice?.getAttribute("aria-checked")).toBe("true");
    const fallbackToggle = container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${s.labels["general.me2dc_fallback"]}"]`);
    expect(fallbackToggle?.disabled).toBe(true);
  });

  it("separates safe ME controls from legacy NAT fields in normal mode", () => {
    const fields = [
      field("general.middle_proxy_nat_probe", "boolean", "me", "bool"),
      field("general.middle_proxy_pool_size", "integer", "me", "usize"),
      field("general.middle_proxy_warm_standby", "integer", "me", "usize"),
      field("general.hardswap", "boolean", "me", "bool"),
      { ...field("general.middle_proxy_nat_ip", "string", "me", "IpAddr"), tier: "advanced" as const },
      { ...field("general.middle_proxy_nat_stun", "string", "me"), tier: "advanced" as const },
    ];
    const sections = {
      general: {
        use_middle_proxy: false,
        middle_proxy_nat_probe: true,
        middle_proxy_pool_size: 8,
        middle_proxy_warm_standby: 16,
        hardswap: true,
      },
    };
    const onChange = vi.fn();
    act(() => root.render(<StructuredSettingsForm catalog={catalog("me", fields)} sections={sections} mode="normal" onChange={onChange} />));

    const s = getStrings().server.config.catalog;
    expect(container.textContent).toContain(s.meDisabledTitle);
    expect(container.textContent).toContain(s.meCapacityTitle);
    expect(container.textContent).not.toContain(s.labels["general.middle_proxy_nat_ip"]);
    expect(container.textContent).not.toContain(s.labels["general.middle_proxy_nat_stun"]);

    const probe = container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${s.labels["general.middle_proxy_nat_probe"]}"]`);
    act(() => probe?.click());
    expect(onChange.mock.calls[0][0].general.middle_proxy_nat_probe).toBe(false);
  });

  it("groups listeners as records and converts MTProxy fields to a valid WEB listener", () => {
    const transportField = { ...field("server.listeners[].transport", "enum", "listeners", '"mtproxy" or "web"'), options: ["mtproxy", "web"] };
    const fields = [
      transportField,
      field("server.listeners[].ip", "string", "listeners", "IpAddr"),
      field("server.listeners[].port", "integer", "listeners", "u16"),
      field("server.listeners[].announce", "string", "listeners"),
      field("server.listeners[].web_trusted_proxy_cidrs", "string_list", "listeners", "IpNetwork[]"),
    ];
    const sections = {
      server: {
        listeners: [
          { ip: "0.0.0.0", port: 443, transport: "mtproxy", announce: "proxy.example.com", synlimit: "iptables" },
          { ip: "127.0.0.1", port: 18080, transport: "web", web_trusted_proxy_cidrs: ["127.0.0.1/32"] },
        ],
      },
    };
    const onChange = vi.fn();
    act(() => root.render(<StructuredSettingsForm catalog={catalog("listeners", fields)} sections={sections} mode="normal" onChange={onChange} />));

    const s = getStrings().server.config.catalog;
    expect(container.textContent).toContain("0.0.0.0:443");
    expect(container.textContent).toContain("127.0.0.1:18080");
    expect(container.textContent).toContain(s.listenerMtproxy);
    expect(container.textContent).toContain(s.listenerWeb);
    expect(container.querySelectorAll(`button[aria-label="${s.duplicateRecord}"]`)).toHaveLength(2);

    const transport = container.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      transport.value = "web";
      transport.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const next = onChange.mock.calls[0][0] as typeof sections;
    expect(next.server.listeners[0]).toMatchObject({
      transport: "web",
      proxy_protocol: false,
      reuse_allow: false,
      web_client_ip_source: "x_forwarded_for",
      web_trusted_proxy_cidrs: ["127.0.0.1/32"],
    });
    expect(next.server.listeners[0]).not.toHaveProperty("announce");
    expect(next.server.listeners[0]).not.toHaveProperty("synlimit");
  });

  it("renders WEB vhosts and carrier negotiation as structured controls", () => {
    const fields = [
      field("web.enabled", "boolean", "web", "bool"),
      { ...field("web.carrier", "enum", "web"), options: ["https", "https-lanes", "websocket", "websocket-lanes"] },
      field("web.carriers", "string", "web"),
      field("web.carrier_learning", "boolean", "web", "bool"),
      { ...field("web.carrier_negotiation_aggressiveness", "enum", "web"), options: ["conservative", "balanced", "aggressive"] },
      field("web.vhosts", "structure", "web"),
      field("web.vhosts[].host", "string", "web"),
      field("web.vhosts[].public_addr", "string", "web"),
      field("web.vhosts[].decoy", "structure", "web"),
      { ...field("web.vhosts[].decoy.mode", "enum", "web"), options: ["http_upstream", "static_directory"] },
      field("web.vhosts[].decoy.upstream", "string", "web"),
      field("web.vhosts[].decoy.directory", "string", "web"),
      field("web.vhosts[].decoy.index", "string", "web"),
      field("web.vhosts[].profiles", "structure", "web"),
      field("web.vhosts[].profiles[].user", "string", "web"),
      { ...field("web.vhosts[].profiles[].secret_mode", "enum", "web"), options: ["plain", "dd"] },
      field("web.vhosts[].profiles[].max_sessions", "integer", "web", "usize"),
      field("web.vhosts[].profiles[].max_streams", "integer", "web", "usize"),
      field("web.vhosts[].profiles[].max_streams_per_session", "integer", "web", "usize"),
    ];
    const sections = {
      access: { users: { alice: "secret-a", bob: "secret-b" } },
      server: { listeners: [{ ip: "127.0.0.1", port: 18080, transport: "web", web_trusted_proxy_cidrs: ["127.0.0.1/32"] }] },
      web: {
        enabled: false,
        carrier: "https",
        carriers: false,
        carrier_learning: true,
        carrier_negotiation_aggressiveness: "conservative",
        vhosts: [{
          host: "proxy.example.com",
          public_addr: "203.0.113.10:443",
          decoy: { mode: "http_upstream", upstream: "http://127.0.0.1:8080" },
          profiles: [{ user: "alice", secret_mode: "plain" }],
        }],
      },
    };
    const onChange = vi.fn();
    act(() => root.render(<StructuredSettingsForm catalog={catalog("web", fields)} sections={sections} mode="normal" onChange={onChange} />));

    const s = getStrings().server.config.catalog;
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("proxy.example.com");
    expect(container.textContent).toContain(s.webVhostsReady);
    expect(container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${s.labels["web.enabled"]}"]`)?.disabled).toBe(false);

    const negotiated = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
      .find((button) => button.textContent?.includes(s.webCarrierNegotiated));
    act(() => negotiated?.click());
    expect(onChange.mock.calls[0][0].web.carriers).toEqual(["https", "https-lanes", "websocket", "websocket-lanes"]);

    const decoy = container.querySelector<HTMLSelectElement>(`select[aria-label="${s.labels["web.vhosts.decoy.mode"]}"]`)!;
    act(() => {
      decoy.value = "static_directory";
      decoy.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange.mock.calls[1][0].web.vhosts[0].decoy).toEqual({ mode: "static_directory", directory: "/var/www/html", index: "index.html" });
  });

  it("can create the first WEB vhost when the optional section is absent", () => {
    const fields = [
      field("web.enabled", "boolean", "web", "bool"),
      { ...field("web.carrier", "enum", "web"), options: ["https", "https-lanes", "websocket", "websocket-lanes"] },
      field("web.carriers", "string", "web"),
      field("web.vhosts", "structure", "web"),
      field("web.vhosts[].host", "string", "web"),
      field("web.vhosts[].public_addr", "string", "web"),
    ];
    const onChange = vi.fn();
    act(() => root.render(<StructuredSettingsForm catalog={catalog("web", fields)} sections={{ server: { listeners: [] } }} mode="normal" onChange={onChange} />));

    const s = getStrings().server.config.catalog;
    const add = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes(s.webAddVhost));
    expect(add).toBeTruthy();
    act(() => add?.click());
    expect(onChange.mock.calls[0][0].web.vhosts).toHaveLength(1);
  });

  it("blocks WEB activation until a listener and complete vhost exist", () => {
    const fields = [
      field("web.enabled", "boolean", "web", "bool"),
      { ...field("web.carrier", "enum", "web"), options: ["https", "https-lanes", "websocket", "websocket-lanes"] },
      field("web.carriers", "string", "web"),
      field("web.vhosts", "structure", "web"),
    ];
    const sections = {
      server: { listeners: [{ ip: "0.0.0.0", port: 443, transport: "mtproxy" }] },
      web: { enabled: false, carrier: "https", carriers: false, vhosts: [] },
    };
    act(() => root.render(<StructuredSettingsForm catalog={catalog("web", fields)} sections={sections} mode="normal" onChange={() => {}} />));

    const s = getStrings().server.config.catalog;
    const enabled = container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${s.labels["web.enabled"]}"]`);
    expect(enabled?.disabled).toBe(true);
    expect(container.textContent).toContain(s.webEnableBlocked);
    expect(container.textContent).toContain(s.webListenerMissing);
  });

  it("keeps advanced WEB limits and timeouts complete but collapsed by domain", () => {
    const advancedField = (path: string) => ({ ...field(path, "integer" as const, "web", "usize"), tier: "advanced" as const });
    const fields = [
      field("web.enabled", "boolean", "web", "bool"),
      { ...field("web.carrier", "enum", "web"), options: ["https", "https-lanes", "websocket", "websocket-lanes"] },
      field("web.carriers", "string", "web"),
      field("web.vhosts", "structure", "web"),
      advancedField("web.limits.max_sessions_global"),
      advancedField("web.timeouts.header_secs"),
      { ...field("web.debug.body_capture", "enum", "web"), options: ["off", "metadata", "prefix", "full"], tier: "advanced" as const },
    ];
    const sections = {
      server: { listeners: [] },
      web: {
        enabled: false,
        carrier: "https",
        carriers: false,
        vhosts: [],
        limits: { max_sessions_global: 2048 },
        timeouts: { header_secs: 10 },
        debug: { body_capture: "metadata" },
      },
    };
    act(() => root.render(<StructuredSettingsForm catalog={catalog("web", fields)} sections={sections} mode="advanced" onChange={() => {}} />));

    const s = getStrings().server.config.catalog;
    const limitSection = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')]
      .find((button) => button.textContent?.includes(s.webLimitsTitle));
    expect(limitSection).toBeTruthy();
    expect(container.textContent).not.toContain("web.limits.max_sessions_global");
    expect(container.querySelector("textarea")).toBeNull();
    act(() => limitSection?.click());
    expect(container.textContent).toContain("web.limits.max_sessions_global");
  });
});
