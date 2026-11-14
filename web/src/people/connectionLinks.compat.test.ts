import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserLinksWire } from "../realtime/topics";
import { collectConnectionLinks, formatConnectionLink, withConnectionAddress, type ConnectionLink } from "./connectionLinks";

const NativeURL = globalThis.URL;

// Reproduce issue #182's non-special scheme URL shape while retaining the
// real URL parser for query decoding, mutation, and HTTPS links.
class OpaqueTelegramURL extends NativeURL {
  get hostname() { return super.protocol === "tg:" ? "" : super.hostname; }
  get host() { return super.protocol === "tg:" ? "" : super.host; }
  get username() { return super.protocol === "tg:" ? "" : super.username; }
  get password() { return super.protocol === "tg:" ? "" : super.password; }
  get port() { return super.protocol === "tg:" ? "" : super.port; }
  get pathname() { return super.protocol === "tg:" ? super.href.slice(3).split(/[?#]/, 1)[0]! : super.pathname; }
}

const secret = "000102030405060708090a0b0c0d0e0f";
const tlsSecret = `ee${secret}6d61736b2e6578616d706c65`;
const tlsLink = `tg://proxy?server=example.com&port=443&secret=${tlsSecret}`;
const links = (override: Partial<UserLinksWire>): UserLinksWire => ({ classic: [], secure: [], tls: [], tls_domains: [], ...override });

describe.each([
  ["standard", NativeURL],
  ["opaque tg scheme from issue #182", OpaqueTelegramURL],
] as const)("connection links with %s URL parsing", (_, Parser) => {
  beforeEach(() => vi.stubGlobal("URL", Parser));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["classic", secret, null],
    ["secure", `dd${secret}`, null],
    ["tls", tlsSecret, "mask.example"],
  ] as const)("keeps a valid %s link", (kind, encodedSecret, domain) => {
    const raw = `tg://proxy?server=example.com&port=443&secret=${encodedSecret}`;
    expect(collectConnectionLinks(links({ [kind]: [raw] }))).toEqual([
      { kind, url: raw, endpoint: "example.com:443", domain, primary: true },
    ]);
  });

  it("keeps the TLS-domain fallback when the primary TLS list is empty", () => {
    expect(collectConnectionLinks(links({ tls_domains: [{ domain: "mask.example", link: tlsLink }] }))).toEqual([
      { kind: "tls", url: tlsLink, endpoint: "example.com:443", domain: "mask.example", primary: false },
    ]);
  });

  it("normalizes and deduplicates equivalent Telegram and HTTPS links", () => {
    const httpsLink = `https://t.me/proxy?server=example.com&port=443&secret=${tlsSecret}`;
    const collected = collectConnectionLinks(links({ tls: [tlsLink, httpsLink] }));
    expect(collected).toEqual([{ kind: "tls", url: tlsLink, endpoint: "example.com:443", domain: "mask.example", primary: true }]);
    expect(formatConnectionLink(collected[0]!, "tme")).toBe(httpsLink);
  });

  it("derives path-mounted WEB links before filtering absent MTProto listeners", () => {
    expect(collectConnectionLinks(links({ tls: [tlsLink] }), [{ host: "web.example.com", mode: "dd", basePath: "Relay/app" }], "absent")).toEqual([
      { kind: "web", url: "tg://webproxy?server=web.example.com%2FRelay%2Fapp&secret=cN0AAQIDBAUGBwgJCgsMDQ4P", endpoint: "web.example.com/Relay/app", domain: null, profileMode: "dd", primary: true },
    ]);
  });

  it("changes the explicit connection address without altering the secret or TLS domain", () => {
    const original: ConnectionLink = { kind: "tls", url: tlsLink, endpoint: "example.com:443", domain: "mask.example", primary: true };
    expect(withConnectionAddress(original, "other.example")).toEqual({
      ...original, url: `tg://proxy?server=other.example&port=443&secret=${tlsSecret}`, endpoint: "other.example:443",
    });
    expect(original.url).toBe(tlsLink);
  });

  it.each([
    ["another Telegram action", tlsLink.replace("tg://proxy", "tg://resolve")],
    ["another Telegram target", tlsLink.replace("tg://proxy", "tg://proxy.evil.example")],
    ["extra Telegram path", tlsLink.replace("tg://proxy", "tg://proxy/extra")],
    ["Telegram credentials", tlsLink.replace("tg://proxy", "tg://user:password@proxy")],
    ["fragment", `${tlsLink}#fragment`],
    ["duplicate server", `${tlsLink}&server=other.example`],
    ["duplicate port", `${tlsLink}&port=8443`],
    ["duplicate secret", `${tlsLink}&secret=${tlsSecret}`],
    ["missing server", tlsLink.replace("server=example.com&", "")],
    ["zero port", tlsLink.replace("port=443", "port=0")],
    ["out-of-range port", tlsLink.replace("port=443", "port=65536")],
    ["non-numeric port", tlsLink.replace("port=443", "port=invalid")],
    ["server whitespace", tlsLink.replace("server=example.com", "server=bad%20host")],
    ["unrelated HTTPS host", tlsLink.replace("tg://proxy", "https://evil.example/proxy")],
  ])("still rejects %s", (_, raw) => {
    expect(collectConnectionLinks(links({ tls: [raw] }))).toEqual([]);
  });
});
