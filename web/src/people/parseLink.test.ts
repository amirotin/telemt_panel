import { describe, expect, it } from "vitest";
import { parseLink } from "./parseLink";

const SECRET = "deadbeefdeadbeefdeadbeefdeadbeef";

// domainHex("example.com") === "6578616d706c652e636f6d" — verified against
// Buffer.from("example.com","utf8").toString("hex") independently of this
// module's own hexToUtf8 decoder, so the round trip below is a real check.
function domainHex(domain: string): string {
  return Array.from(new TextEncoder().encode(domain))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("parseLink", () => {
  it("parses a classic link (no secret prefix)", () => {
    const link = `tg://proxy?server=example.com&port=443&secret=${SECRET}`;
    expect(parseLink(link)).toEqual({
      type: "classic",
      server: "example.com",
      port: "443",
      secret: SECRET,
      domain: null,
      raw: link,
    });
  });

  it("parses a secure link (dd prefix)", () => {
    const link = `tg://proxy?server=example.com&port=443&secret=dd${SECRET}`;
    const parsed = parseLink(link);
    expect(parsed.type).toBe("secure");
    expect(parsed.secret).toBe(SECRET);
    expect(parsed.domain).toBeNull();
  });

  it("parses a fake-TLS link (ee prefix + hex domain)", () => {
    const link = `tg://proxy?server=example.com&port=443&secret=ee${SECRET}${domainHex("example.com")}`;
    const parsed = parseLink(link);
    expect(parsed.type).toBe("tls");
    expect(parsed.secret).toBe(SECRET);
    expect(parsed.domain).toBe("example.com");
  });

  it("parses an https://t.me/proxy fallback link the same way", () => {
    const link = `https://t.me/proxy?server=example.com&port=443&secret=dd${SECRET}`;
    expect(parseLink(link).type).toBe("secure");
  });

  it("normalizes an uppercase secret to lowercase", () => {
    const link = `tg://proxy?server=h&port=1&secret=${SECRET.toUpperCase()}`;
    expect(parseLink(link).secret).toBe(SECRET);
  });

  it("normalizes an uppercase dd/ee prefix too", () => {
    const link = `tg://proxy?server=h&port=1&secret=DD${SECRET.toUpperCase()}`;
    expect(parseLink(link).type).toBe("secure");
  });

  it("is unknown when there is no secret param at all", () => {
    const link = "tg://proxy?server=h&port=1";
    const parsed = parseLink(link);
    expect(parsed.type).toBe("unknown");
    expect(parsed.secret).toBeNull();
  });

  it("is unknown for a malformed (too short) secret", () => {
    const link = "tg://proxy?server=h&port=1&secret=deadbeef";
    expect(parseLink(link).type).toBe("unknown");
  });

  it("is unknown for a secret with non-hex characters", () => {
    const link = "tg://proxy?server=h&port=1&secret=zzzzbeefdeadbeefdeadbeefdeadbeef";
    expect(parseLink(link).type).toBe("unknown");
  });

  it("is unknown for an unparseable URL", () => {
    expect(parseLink("not a url at all").type).toBe("unknown");
  });

  it("still returns type=tls with a null domain when the hex suffix is empty", () => {
    const link = `tg://proxy?server=h&port=1&secret=ee${SECRET}`;
    const parsed = parseLink(link);
    expect(parsed.type).toBe("tls");
    expect(parsed.secret).toBe(SECRET);
    expect(parsed.domain).toBeNull();
  });

  it("still returns type=tls with a null domain when the hex suffix is malformed", () => {
    const link = `tg://proxy?server=h&port=1&secret=ee${SECRET}zz`;
    const parsed = parseLink(link);
    expect(parsed.type).toBe("tls");
    expect(parsed.domain).toBeNull();
  });

  it("round-trips server/port for every link type", () => {
    const link = `tg://proxy?server=203.0.113.10&port=8443&secret=${SECRET}`;
    const parsed = parseLink(link);
    expect(parsed.server).toBe("203.0.113.10");
    expect(parsed.port).toBe("8443");
  });
});
