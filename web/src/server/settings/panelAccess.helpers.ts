import type {
  PanelTlsCandidate,
  PanelTlsSettings,
  PreparePanelTlsData,
} from "../../lib/api/generated/types.gen";

export type PanelAccessMode = "acme" | "certificate" | "proxy" | "http";

export interface PanelAccessDraft {
  publicURL?: string;
  basePath?: string;
  enabled?: boolean;
  mode: PanelAccessMode;
  host: string;
  port: string;
  domain: string;
  cacheDir: string;
  certFile: string;
  keyFile: string;
  httpConfirmed: boolean;
}

export function panelAccessMode(candidate: PanelTlsCandidate, browserProtocol: string): PanelAccessMode {
  if (candidate.tls.mode !== "http") return candidate.tls.mode;
  return (candidate.public_url ? candidate.public_url.startsWith("https://") : browserProtocol === "https:") ? "proxy" : "http";
}

export function splitPanelListen(listen: string): { host: string; port: string } {
  if (listen.startsWith("[")) {
    const end = listen.indexOf("]");
    if (end >= 0 && listen[end + 1] === ":") {
      return { host: listen.slice(1, end), port: listen.slice(end + 2) };
    }
  }
  const separator = listen.lastIndexOf(":");
  if (separator < 0) return { host: listen, port: "" };
  return { host: listen.slice(0, separator), port: listen.slice(separator + 1) };
}

export function joinPanelListen(host: string, port: string): string {
  const cleanHost = host.trim();
  const formattedHost = cleanHost.includes(":") && !cleanHost.startsWith("[") ? `[${cleanHost}]` : cleanHost;
  return `${formattedHost}:${port.trim()}`;
}

export function createPanelAccessDraft(settings: PanelTlsSettings, browserProtocol: string): PanelAccessDraft {
  const candidate = settings.configured ?? settings.active;
  const { host, port } = splitPanelListen(candidate.listen);
  return {
    mode: panelAccessMode(candidate, browserProtocol),
    host,
    port,
    domain: candidate.tls.acme_domain ?? "",
    cacheDir: candidate.tls.acme_cache_dir ?? settings.default_acme_cache_dir,
    certFile: candidate.tls.cert_file ?? "",
    keyFile: candidate.tls.key_file ?? "",
    httpConfirmed: false,
    publicURL: candidate.public_url ?? "",
    basePath: candidate.base_path ?? "",
    enabled: candidate.enabled ?? false,
  };
}

export function buildPanelTlsPrepareBody(draft: PanelAccessDraft): PreparePanelTlsData["body"] {
  const address = splitAccessURL(draft.publicURL ?? "", draft.basePath ?? "");
  const body: PreparePanelTlsData["body"] = {
    listen: joinPanelListen(draft.host, draft.port),
    tls: { mode: draft.mode === "proxy" ? "http" : draft.mode },
    base_path: address.basePath,
    public_url: address.publicURL,
    enabled: draft.enabled ?? false,
  };
  if (draft.mode === "acme") {
    body.tls.acme_domain = draft.domain.trim();
    if (draft.cacheDir.trim()) body.tls.acme_cache_dir = draft.cacheDir.trim();
  } else if (draft.mode === "certificate") {
    body.tls.cert_file = draft.certFile.trim();
    body.tls.key_file = draft.keyFile.trim();
  } else if (
    draft.httpConfirmed
    && (draft.mode === "http" || (draft.mode === "proxy" && !isLoopbackHost(draft.host)))
  ) {
    body.confirm_http = true;
  }
  return body;
}

export function splitAccessURL(publicURL: string, basePath: string) {
  try {
    const url = new URL(publicURL.trim());
    if (url.pathname !== "/" && !url.search && !url.hash && !url.username && !url.password) {
      return { publicURL: url.origin, basePath: url.pathname.replace(/\/+$/, "") };
    }
  } catch {
    // Preserve unfinished input; submit validation provides the explanation.
  }
  return { publicURL: publicURL.trim(), basePath };
}

export function safePanelDestination(url: string | undefined, mode: PanelAccessMode): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
    if (mode === "proxy" && (parsed.protocol !== "https:" || isLoopbackHost(parsed.hostname))) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function panelPort(candidate: PanelTlsCandidate): string {
  return splitPanelListen(candidate.listen).port;
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "localhost" || value === "::1") return true;
  const octets = value.split(".");
  return octets.length === 4 && octets[0] === "127"
    && octets.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}
