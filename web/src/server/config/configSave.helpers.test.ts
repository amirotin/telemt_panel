import { describe, expect, it } from "vitest";
import { preserveLateConfigEdits } from "./configSave.helpers";

describe("preserveLateConfigEdits", () => {
  it("keeps edits made after the submitted snapshot", () => {
    const fresh = { general: { log_level: "debug", tg_connect: 12 } };
    const submitted = { general: { log_level: "debug", tg_connect: 10 } };
    const latest = { general: { log_level: "debug", tg_connect: 15 } };

    expect(preserveLateConfigEdits(fresh, submitted, latest)).toEqual({
      general: { log_level: "debug", tg_connect: 15 },
    });
  });

  it("uses the fresh response when no later edit exists", () => {
    const fresh = { general: { log_level: "debug" }, web: { enabled: true } };
    const submitted = { general: { log_level: "debug" } };
    expect(preserveLateConfigEdits(fresh, submitted, submitted)).toBe(fresh);
  });

  it("preserves a post-submit revert as an intentional edit", () => {
    const fresh = { general: { tg_connect: 15 } };
    const submitted = { general: { tg_connect: 15 } };
    const latest = { general: { tg_connect: 10 } };
    expect(preserveLateConfigEdits(fresh, submitted, latest)).toEqual(latest);
  });
});
