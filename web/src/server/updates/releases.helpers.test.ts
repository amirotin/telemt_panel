import { describe, expect, it } from "vitest";
import { pickLatestRelease, type ReleaseItem } from "./releases.helpers";

function release(version: string, newer: boolean): ReleaseItem {
  return { version, published_at: "2026-08-01T00:00:00Z", newer };
}

describe("pickLatestRelease", () => {
  it("picks the first release marked newer (list is semver-descending)", () => {
    const releases = [release("1.3.0", true), release("1.2.0", true), release("1.1.0", false)];
    expect(pickLatestRelease(releases)?.version).toBe("1.3.0");
  });

  it("returns null when nothing is newer than the installed version", () => {
    const releases = [release("1.1.0", false), release("1.0.0", false)];
    expect(pickLatestRelease(releases)).toBeNull();
  });

  it("returns null for an empty release list", () => {
    expect(pickLatestRelease([])).toBeNull();
  });
});
