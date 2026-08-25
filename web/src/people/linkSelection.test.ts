import { describe, expect, it } from "vitest";
import { pickTelegramLink, isSafeTelegramLink } from "./linkSelection";

function links(over: Partial<{ classic: string[]; secure: string[]; tls: string[] }> = {}) {
  return {
    classic: [],
    secure: [],
    tls: [],
    tls_domains: [],
    ...over,
  };
}

describe("pickTelegramLink", () => {
  it("prefers tls when present", () => {
    expect(
      pickTelegramLink(links({ classic: ["c"], secure: ["s"], tls: ["t"] })),
    ).toBe("t");
  });

  it("falls back to secure when there is no tls link", () => {
    expect(pickTelegramLink(links({ classic: ["c"], secure: ["s"] }))).toBe("s");
  });

  it("falls back to classic when there is neither tls nor secure", () => {
    expect(pickTelegramLink(links({ classic: ["c"] }))).toBe("c");
  });

  it("is null when there are no links at all", () => {
    expect(pickTelegramLink(links())).toBeNull();
  });
});

describe("isSafeTelegramLink", () => {
  const cases: Array<[string, boolean]> = [
    ["javascript:alert(1)", false],
    ["https://evil.example/proxy", false],
    ["tg://proxy?server=1.2.3.4&port=443&secret=abc", true],
    ["https://t.me/proxy?server=1.2.3.4&port=443&secret=abc", true],
    ["HTTPS://T.ME/proxy?server=1.2.3.4", true],
    ["https://t.me.evil.example", false],
    ["http://t.me/proxy", false],
    ["not a url", false],
    ["//evil.example", false],
  ];

  it.each(cases)("%s -> %s", (link, expected) => {
    expect(isSafeTelegramLink(link)).toBe(expected);
  });
});
