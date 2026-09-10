import { describe, expect, it } from "vitest";
import type { PanelTlsSettings } from "../../lib/api/generated/types.gen";
import {
  buildPanelTlsPrepareBody,
  createPanelAccessDraft,
  isLoopbackHost,
  panelAccessMode,
  safePanelDestination,
} from "./panelAccess.helpers";

const settings: PanelTlsSettings = {
  active: { listen: "10.0.0.8:8080", tls: { mode: "http" } },
  configured: { listen: "10.0.0.8:8080", tls: { mode: "http" } },
  capabilities: { config_writable: true, restart: true, prepare: true, acme_prepare: true },
  manual_hints: [],
  default_acme_cache_dir: "/etc/telemt-panel/certs",
  manual_restart_command: "systemctl restart telemt-panel",
  state: "idle",
  restart_required: false,
};

describe("panel access helpers", () => {
  it("does not mistake hostnames or invalid IPs starting with 127 for loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("127.proxy.example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.999")).toBe(false);
  });
  it("infers proxy presentation only from HTTPS browser transport over runtime HTTP", () => {
    expect(panelAccessMode(settings.active, "https:")).toBe("proxy");
    expect(panelAccessMode(settings.active, "http:")).toBe("http");
    expect(panelAccessMode({ ...settings.active, tls: { mode: "acme" } }, "https:")).toBe("acme");
  });

  it("preserves a custom host while editing an inferred proxy port", () => {
    const draft = { ...createPanelAccessDraft(settings, "https:"), port: "9443" };
    expect(buildPanelTlsPrepareBody(draft)).toEqual({ base_path: "", public_url: "", enabled: false,
      listen: "10.0.0.8:9443",
      tls: { mode: "http" },
    });
  });

  it("sends explicit HTTP confirmation for a preserved non-loopback proxy binding", () => {
    const draft = { ...createPanelAccessDraft(settings, "https:"), port: "9443", httpConfirmed: true };
    expect(buildPanelTlsPrepareBody(draft)).toEqual({ base_path: "", public_url: "", enabled: false,
      listen: "10.0.0.8:9443",
      tls: { mode: "http" },
      confirm_http: true,
    });
  });

  it("uses loopback only after proxy mode is explicitly selected", () => {
    const draft = createPanelAccessDraft(settings, "http:");
    expect(buildPanelTlsPrepareBody({ ...draft, mode: "proxy", host: "127.0.0.1" })).toEqual({ base_path: "", public_url: "", enabled: false,
      listen: "127.0.0.1:8080",
      tls: { mode: "http" },
    });
  });

  it("builds the exact direct prepare payload and omits irrelevant TLS fields", () => {
    const draft = {
      ...createPanelAccessDraft(settings, "http:"),
      mode: "acme" as const,
      host: "0.0.0.0",
      port: "8443",
      domain: "panel.example.com",
      cacheDir: "/var/lib/telemt-panel/certs",
      certFile: "/ignored/fullchain.pem",
      keyFile: "/ignored/key.pem",
    };
    expect(buildPanelTlsPrepareBody(draft)).toEqual({ base_path: "", public_url: "", enabled: false,
      listen: "0.0.0.0:8443",
      tls: { mode: "acme", acme_domain: "panel.example.com", acme_cache_dir: "/var/lib/telemt-panel/certs" },
    });
  });

  it("never turns a credential-bearing or loopback proxy URL into a destination link", () => {
    expect(safePanelDestination("https://admin:secret@panel.example.com:8443", "acme")).toBeUndefined();
    expect(safePanelDestination("http://127.0.0.1:8080", "proxy")).toBeUndefined();
    expect(safePanelDestination("https://links.example.com/clients", "proxy")).toBe("https://links.example.com/clients");
    expect(safePanelDestination("https://panel.example.com:8443", "acme")).toBe("https://panel.example.com:8443/");
  });
});
