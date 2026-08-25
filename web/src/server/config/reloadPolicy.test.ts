import { describe, expect, it } from "vitest";
import { toPatchReloadQuery } from "./reloadPolicy";

describe("toPatchReloadQuery", () => {
  it("sends no query at all for 'none'", () => {
    expect(toPatchReloadQuery({ mode: "none", timeoutSecs: 30 })).toEqual({});
  });

  it("sends reload=instant with no timeout_secs", () => {
    expect(toPatchReloadQuery({ mode: "instant", timeoutSecs: 30 })).toEqual({ reload: "instant" });
  });

  it("sends reload=drain with the chosen timeout_secs", () => {
    expect(toPatchReloadQuery({ mode: "drain", timeoutSecs: 45 })).toEqual({ reload: "drain", timeout_secs: 45 });
  });
});
