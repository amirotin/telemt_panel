import { describe, expect, it } from "vitest";
import { generateSecret } from "./secret";
import { isValidSecret } from "./users.helpers";

describe("generateSecret", () => {
  it("produces a valid 32-hex secret", () => {
    expect(isValidSecret(generateSecret())).toBe(true);
  });

  it("produces different secrets across calls", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
  });
});
