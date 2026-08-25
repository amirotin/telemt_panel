import { describe, expect, it } from "vitest";
import { classifyRequest } from "./swRouting";

describe("classifyRequest (public/sw.js's routing decision, mirrored)", () => {
  it("bypasses the API — never cached, never served from cache", () => {
    expect(classifyRequest("/api/users", "/")).toBe("bypass");
    expect(classifyRequest("/api/", "/")).toBe("bypass");
  });

  it("bypasses the subscription page — always live, per-token data", () => {
    expect(classifyRequest("/sub/abc123", "/")).toBe("bypass");
  });

  it("does not bypass a path that merely starts with api/sub as a substring, not a segment", () => {
    // "/apikey" and "/subway" are not under /api/ or /sub/ — the scope
    // check is prefix-with-trailing-slash, not a bare startsWith("api")/
    // startsWith("sub").
    expect(classifyRequest("/apikey", "/")).toBe("network-first");
    expect(classifyRequest("/subway", "/")).toBe("network-first");
  });

  it("cache-first for the content-hashed assets/ bundle", () => {
    expect(classifyRequest("/assets/index-abc123.js", "/")).toBe("cache-first");
  });

  it("network-first for everything else (the shell: index.html, manifest, icons)", () => {
    expect(classifyRequest("/", "/")).toBe("network-first");
    expect(classifyRequest("/index.html", "/")).toBe("network-first");
    expect(classifyRequest("/manifest.webmanifest", "/")).toBe("network-first");
    expect(classifyRequest("/some/spa/route", "/")).toBe("network-first");
  });

  it("honors a non-root scope (base_path) for every branch", () => {
    const scope = "/panel/";
    expect(classifyRequest("/panel/api/users", scope)).toBe("bypass");
    expect(classifyRequest("/panel/sub/abc123", scope)).toBe("bypass");
    expect(classifyRequest("/panel/assets/index-abc123.js", scope)).toBe("cache-first");
    expect(classifyRequest("/panel/", scope)).toBe("network-first");
    // A path outside the scope entirely (shouldn't normally reach a
    // scoped SW's fetch handler at all, but the function itself has no
    // opinion beyond its own prefix checks) still falls through to the
    // network-first default rather than mis-bypassing.
    expect(classifyRequest("/api/users", scope)).toBe("network-first");
  });
});
