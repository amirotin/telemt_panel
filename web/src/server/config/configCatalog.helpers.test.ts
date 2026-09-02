import { describe, expect, it } from "vitest";
import type { TelemtConfigField } from "../../lib/api/generated/types.gen";
import {
  catalogFieldMatches,
  fieldInstances,
  getConfigValue,
  setConfigValue,
} from "./configCatalog.helpers";

const baseField: TelemtConfigField = {
  path: "general.enabled",
  data_type: "bool",
  kind: "boolean",
  default_value: "true",
  doc_hot: true,
  apply: "runtime reload",
  tier: "normal",
  group: "routing",
  secret: false,
};

describe("config catalog helpers", () => {
  it("expands nested array records into concrete paths", () => {
    const field = { ...baseField, path: "web.vhosts[].profiles[].user" };
    const sections = {
      web: {
        vhosts: [
          { profiles: [{ user: "alice" }, { user: "bob" }] },
          { profiles: [{ user: "carol" }] },
        ],
      },
    };
    expect(fieldInstances(sections, field).map((item) => [item.concretePath, item.value])).toEqual([
      ["web.vhosts[0].profiles[0].user", "alice"],
      ["web.vhosts[0].profiles[1].user", "bob"],
      ["web.vhosts[1].profiles[0].user", "carol"],
    ]);
  });

  it("keeps an absent scalar field addressable", () => {
    const instances = fieldInstances({ general: {} }, baseField);
    expect(instances).toEqual([{ field: baseField, concretePath: "general.enabled", value: undefined }]);
  });

  it("updates a nested record without mutating its source", () => {
    const source = { upstreams: [{ weight: 1 }, { weight: 2 }] };
    const next = setConfigValue(source, "upstreams[1].weight", 7);
    expect(getConfigValue(next, "upstreams[1].weight")).toBe(7);
    expect(source.upstreams[1].weight).toBe(2);
  });

  it("searches labels, paths, types and defaults", () => {
    expect(catalogFieldMatches(baseField, "включ", "Включено")).toBe(true);
    expect(catalogFieldMatches(baseField, "general.enabled", "Включено")).toBe(true);
    expect(catalogFieldMatches(baseField, "u64", "Включено")).toBe(false);
  });
});
