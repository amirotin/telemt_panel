import { describe, expect, it } from "vitest";
import { pickTelegramLink } from "./linkSelection";

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
