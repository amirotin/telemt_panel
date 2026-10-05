import { describe, expect, it } from "vitest";
import { loadOpenAPIYaml } from "./openapi-yaml.mjs";

describe("OpenAPI YAML policy", () => {
  it("counts repeated empty merge sources toward the work limit", () => {
    const input = "sources: &sources [{}, {}, {}]\nfirst:\n  <<: *sources\nsecond:\n  <<: *sources\n";
    expect(() => loadOpenAPIYaml(input, 4)).toThrow(/merge/i);
  });

  it("keeps ordinary aliases and merge precedence usable for schemas", () => {
    const input = "base: &base { type: string }\nvalue:\n  <<: *base\n  description: Example\n";
    expect(loadOpenAPIYaml(input, 10)).toEqual({
      base: { type: "string" },
      value: { type: "string", description: "Example" },
    });
  });

  it("keeps YAML 1.2 labels as strings while resolving true and false", () => {
    expect(loadOpenAPIYaml("labels: [yes, on, no, off]\nflags: [true, false]\n")).toEqual({
      labels: ["yes", "on", "no", "off"],
      flags: [true, false],
    });
  });

  it("rejects JavaScript tags in OpenAPI input", () => {
    expect(() => loadOpenAPIYaml("value: !!js/function 'function () { return 1; }'\n")).toThrow(/tag/i);
  });
});
