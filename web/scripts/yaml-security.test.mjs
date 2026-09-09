import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

describe("YAML merge budget", () => {
  it("counts repeated empty merge sources toward the work limit", () => {
    const input = "sources: &sources [{}, {}, {}]\nfirst:\n  <<: *sources\nsecond:\n  <<: *sources\n";
    expect(() => yaml.load(input, { maxTotalMergeKeys: 4 })).toThrow(/merge/i);
  });

  it("keeps ordinary aliases and merge precedence usable for schemas", () => {
    const input = "base: &base { type: string }\nvalue:\n  <<: *base\n  description: Example\n";
    expect(yaml.load(input, { maxTotalMergeKeys: 10 })).toEqual({
      base: { type: "string" },
      value: { type: "string", description: "Example" },
    });
  });
});
