import { describe, expect, it } from "vitest";
import { isCopyableHostCommand } from "./platform.helpers";

describe("isCopyableHostCommand", () => {
  it.each([
    "systemctl restart telemt",
    "rc-service telemt restart",
    "/etc/init.d/telemt restart",
    "docker restart telemt",
  ])("recognizes a host restart command: %s", (value) => {
    expect(isCopyableHostCommand(value)).toBe(true);
  });

  it("keeps an actionable explanation as prose", () => {
    expect(
      isCopyableHostCommand(
        "binary updates are unavailable because installation privileges are incomplete",
      ),
    ).toBe(false);
  });
});
