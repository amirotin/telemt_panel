import { describe, expect, it } from "vitest";
import { safeRedirectTarget } from "./safeRedirect";

describe("safeRedirectTarget", () => {
  it.each([
    ["/people", "/people"],
    ["/pulse?x=1", "/pulse?x=1"],
    ["/users/a.b", "/users/a.b"],
  ])("accepts %s", (input, expected) => {
    expect(safeRedirectTarget(input)).toBe(expected);
  });

  it.each([
    ["https://evil.example"],
    ["http://evil.example"],
    ["//evil.example"],
    ["\\\\evil.example"],
    ["javascript:alert(1)"],
    ["/\\evil"],
    [""],
    [undefined],
  ])("rejects %s, falling back to /people", (input) => {
    expect(safeRedirectTarget(input)).toBe("/people");
  });

  it.each(["/..//evil.example", "/a/../..//evil", "/%2F%2Fevil.example", "/%2f%2fevil", "/%5Cevil"])(
    "rejects dot-dot segments and percent-encoded slashes: %s",
    (raw) => {
      expect(safeRedirectTarget(raw)).toBe("/people");
    },
  );

  it("rejects a control character smuggled into an otherwise-valid path", () => {
    expect(safeRedirectTarget("/people\n?x=1")).toBe("/people");
    expect(safeRedirectTarget("/people\t?x=1")).toBe("/people");
  });
});
