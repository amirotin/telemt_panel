import { describe, expect, it } from "vitest";
import { creationOptionsFromJSON, requestOptionsFromJSON } from "./webauthn";

function bytes(value: BufferSource): number[] {
  const buffer = value instanceof ArrayBuffer ? value : value.buffer;
  return [...new Uint8Array(buffer)];
}

describe("WebAuthn JSON option conversion", () => {
  it("decodes registration challenge, user and excluded credential IDs", () => {
    const options = creationOptionsFromJSON({
      challenge: "AQID_w",
      rp: { id: "panel.example", name: "Telemt Panel" },
      user: { id: "BAUG", name: "admin", displayName: "admin" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ type: "public-key", id: "BwgJ" }],
    });
    expect(bytes(options.challenge)).toEqual([1, 2, 3, 255]);
    expect(bytes(options.user.id)).toEqual([4, 5, 6]);
    expect(bytes(options.excludeCredentials?.[0]?.id ?? new ArrayBuffer(0))).toEqual([7, 8, 9]);
  });

  it("decodes discoverable-login request options without inventing allowCredentials", () => {
    const options = requestOptionsFromJSON({
      challenge: "AAECAw",
      rpId: "panel.example",
      userVerification: "preferred",
    });
    expect(bytes(options.challenge)).toEqual([0, 1, 2, 3]);
    expect(options.allowCredentials).toBeUndefined();
  });
});
