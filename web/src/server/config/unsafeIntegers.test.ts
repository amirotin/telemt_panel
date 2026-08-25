import { describe, expect, it } from "vitest";
import { findUnsafeIntegerLiterals } from "./unsafeIntegers";

describe("findUnsafeIntegerLiterals", () => {
  it("finds nothing in ordinary small config values", () => {
    const text = '{"general":{"use_middle_proxy":true},"timeouts":{"client_handshake":15}}';
    expect(findUnsafeIntegerLiterals(text)).toEqual([]);
  });

  it("finds an integer literal beyond Number.MAX_SAFE_INTEGER", () => {
    const text = '{"general":{"upstream_id":9007199254740993}}'; // MAX_SAFE_INTEGER + 2
    expect(findUnsafeIntegerLiterals(text)).toEqual(["9007199254740993"]);
  });

  it("finds a negative integer literal beyond Number.MIN_SAFE_INTEGER", () => {
    const text = '{"x":-9007199254740993}';
    expect(findUnsafeIntegerLiterals(text)).toEqual(["-9007199254740993"]);
  });

  it("does not flag Number.MAX_SAFE_INTEGER itself (the boundary is safe)", () => {
    const text = `{"x":${Number.MAX_SAFE_INTEGER}}`;
    expect(findUnsafeIntegerLiterals(text)).toEqual([]);
  });

  it("ignores digits inside a string value, even a huge one", () => {
    const text = '{"ad_tag":"90071992547409930000"}';
    expect(findUnsafeIntegerLiterals(text)).toEqual([]);
  });

  it("ignores digits inside a string containing an escaped quote", () => {
    // The huge digit run sits right after an escaped quote inside the
    // string — a naive "find the next unescaped quote" scanner that
    // doesn't handle \" correctly would treat the escaped quote as the
    // string's end and misread the digits as bare JSON tokens.
    const text = String.raw`{"note":"see \"9007199254740993\" in the docs"}`;
    expect(findUnsafeIntegerLiterals(text)).toEqual([]);
  });

  it("does not flag the integer part of a float or exponent literal", () => {
    const text = '{"a":9007199254740993.5,"b":9007199254740993e2}';
    expect(findUnsafeIntegerLiterals(text)).toEqual([]);
  });

  it("does not flag a long fractional digit run as its own unsafe integer", () => {
    // Regression: an earlier version only checked the character *after* a
    // matched digit run for '.'/'e', which correctly skipped the "1" in
    // "1.12345678901234567" but then re-matched the 17-digit fraction tail
    // on the regex's next iteration as an independent, unflagged-by-that-
    // check token — and misjudged it as a huge integer literal.
    const text = '{"a":1.12345678901234567,"b":1e999999999999999}';
    expect(findUnsafeIntegerLiterals(text)).toEqual([]);
  });

  it("finds multiple distinct unsafe literals, de-duplicated", () => {
    const text = '{"a":9007199254740993,"b":9007199254740994,"c":9007199254740993}';
    expect(findUnsafeIntegerLiterals(text)).toEqual(["9007199254740993", "9007199254740994"]);
  });

  it("returns an empty array for invalid JSON text (not this helper's concern)", () => {
    expect(findUnsafeIntegerLiterals("not json at all")).toEqual([]);
  });
});
