// parseLink turns one of Telemt's ready-made connection links (UserLinks.classic
// /secure/tls entries, or a tls_domains[].link — 07-telemt-sdk.md §Users)
// into its display fields (server/port/secret/type[/domain]) for per-field
// CopyField rendering and QR generation on the user detail screen. The panel
// never constructs tg://-links itself (07-telemt-sdk.md SDK rule 6) — this
// only ever parses a link Telemt already built.
//
// Secret-prefix table (confirmed against telemt's own link builder,
// src/maestro/helpers.rs print_proxy_links):
//   classic: secret=<32 hex>                    — no prefix
//   secure:  secret=dd<32 hex>                   — "dd" + the raw secret
//   tls:     secret=ee<32 hex><hex(sni domain)>  — "ee" + the raw secret + the
//                                                   SNI domain, hex-encoded
export type ParsedLinkType = "classic" | "secure" | "tls" | "unknown";

export interface ParsedLink {
  type: ParsedLinkType;
  server: string | null;
  port: string | null;
  /** Normalized lowercase 32-hex secret, or null when unparseable. */
  secret: string | null;
  /** Only set for type "tls", and only when the hex suffix decodes cleanly. */
  domain: string | null;
  raw: string;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX_ONLY = /^[0-9a-f]+$/;

function unparsed(raw: string): ParsedLink {
  return { type: "unknown", server: null, port: null, secret: null, domain: null, raw };
}

// hexToUtf8 decodes an even-length hex string into UTF-8 text, returning
// null for anything malformed (odd length, non-hex characters, invalid
// UTF-8 byte sequence) rather than throwing — a domain that fails to decode
// still leaves the link's type/secret/server/port usable.
function hexToUtf8(hex: string): string | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !HEX_ONLY.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function parseLink(link: string): ParsedLink {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return unparsed(link);
  }

  const secretParam = url.searchParams.get("secret");
  if (!secretParam) return unparsed(link);

  const server = url.searchParams.get("server");
  const port = url.searchParams.get("port");
  const s = secretParam.toLowerCase();

  if (HEX32.test(s)) {
    return { type: "classic", server, port, secret: s, domain: null, raw: link };
  }

  if (s.startsWith("dd") && HEX32.test(s.slice(2))) {
    return { type: "secure", server, port, secret: s.slice(2), domain: null, raw: link };
  }

  if (s.startsWith("ee") && HEX32.test(s.slice(2, 34))) {
    const secret = s.slice(2, 34);
    const domainHex = s.slice(34);
    const domain = hexToUtf8(domainHex);
    return { type: "tls", server, port, secret, domain, raw: link };
  }

  return unparsed(link);
}
